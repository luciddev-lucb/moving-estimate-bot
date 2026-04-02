import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";

function safeParseJSON(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMessages(conversation) {
  // Claude expects: { role: "user"|"assistant", content: [{ type: "text", text: "..." }] }
  return conversation
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: [{ type: "text", text: String(m.content ?? "") }],
    }));
}

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { userId, clientInput } = req.body ?? {};

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Missing or invalid `userId`" });
    }
    if (!clientInput || typeof clientInput !== "string") {
      return res.status(400).json({ error: "Missing or invalid `clientInput`" });
    }

    const claudeApiKey = process.env.CLAUDE_API_KEY;
    if (!claudeApiKey) {
      return res.status(500).json({
        error:
          "Missing `CLAUDE_API_KEY` (set it in Vercel environment variables).",
      });
    }

    const redisKey = `movingbot:${userId}`;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    // Load previous conversation (if any).
    // If Upstash env vars aren't present, we still allow a stateless estimate.
    let conversation = [];
    if (upstashUrl && upstashToken) {
      const redis = new Redis({ url: upstashUrl, token: upstashToken });
      // We store JSON to avoid Upstash returning a raw string that doesn't
      // necessarily match our in-memory shape.
      const stored = safeParseJSON(await redis.get(redisKey));
      conversation = Array.isArray(stored) ? stored : [];
    }

    // Append the new user message.
    conversation.push({ role: "user", content: clientInput });

    const systemPrompt = `
You are an expert moving estimator for Buff Guys Moving Co.

Use this pricing:
- $30 per mover per hour
- $4 per mile

Steps:
1. Identify all items being moved
2. Estimate total hours based on workload
3. Adjust time based on number of movers (diminishing returns)
4. Calculate labor cost and travel cost
5. Provide a clear final estimate

Be concise and professional.
`.trim();

    // To avoid runaway prompt size, cap how much history we send.
    const maxMessages = 16; // last N messages (user+assistant blocks)
    const recentConversation = conversation.slice(-maxMessages);

    // Initialize Claude client only when we know the API key exists.
    const anthropic = new Anthropic({ apiKey: claudeApiKey });
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0.7,
      system: systemPrompt,
      messages: normalizeMessages(recentConversation),
    });

    const reply =
      msg.content?.find((c) => c?.type === "text")?.text ||
      msg.content?.[0]?.text ||
      "No response";

    // Save assistant reply back to Redis (2-hour expiration).
    conversation.push({ role: "assistant", content: reply });

    if (upstashUrl && upstashToken) {
      const redis = new Redis({ url: upstashUrl, token: upstashToken });
      await redis.set(
        redisKey,
        JSON.stringify(conversation.slice(-maxMessages)),
        { ex: 7200 }
      );
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

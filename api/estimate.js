import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";

function setCorsHeaders(req, res) {
  const requestOrigin = req?.headers?.origin;
  // If you set CORS_ORIGIN in Vercel, we will only allow that origin.
  // Otherwise we reflect the request origin (or fall back to '*').
  const configuredOrigin = process.env.CORS_ORIGIN;
  const allowOrigin = configuredOrigin || (requestOrigin ? requestOrigin : "*");

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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
    setCorsHeaders(req, res);

    // Web browsers send a preflight OPTIONS request before certain POSTs.
    if (req.method && req.method === "OPTIONS") {
      return res.status(204).end();
    }

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

Use Washington State Tariff 15-C (Household Goods) pricing rules for move estimates:

1) Determine move type:
- Local moves: 55 miles or less -> use Item 230 (Hourly Rates)
- Long distance moves: more than 55 miles -> use Item 200 (Mileage Rates)

2) Local moves (<= 55 miles) - Item 230 Hourly Rates:
- Minimum hours:
  - Regular hours (Mon–Fri, 8:00am–5:00pm): minimum charge is 1 hour
  - Non-regular hours (before 8:00am / after 5:00pm) and weekends/holidays: minimum charge is 4 hours
- Charge for truck + driver:
  - 3 hours or less: $39.20 to $119.90 per hour
  - More than 3 hours: $37.93 to $116.04 per hour
- Additional charge for each extra worker:
  - 3 hours or less: $30.69 to $104.45 per hour
  - More than 3 hours: $29.63 to $100.84 per hour

3) Long distance moves (> 55 miles) - Item 200 Mileage Rates:
- Mileage rates apply only beyond 55 miles.
- Transportation cost calculation: shipment weight (lbs) * mileage rate (per lb) based on loaded distance and weight; round to nearest cent.
- Since a customer usually won’t know the exact tariff table bin, provide a reasonable min/max range using the tariff mileage-rate envelope:
  - mileage rate per lb is approximately $0.0862 (min) to $1.1111 (max) depending on the tariff table.
- If overnight stays are required: per-diem per employee per overnight is $121.00 to $261.00 (include only if the customer indicates overnight travel).

Steps:
1. Identify all items being moved
2. Determine if the move is local (<=55 miles) or long distance (>55 miles)
3. If local: estimate labor time and apply Item 230 hourly rates (include the correct minimum hour rule)
4. If long distance: estimate shipment weight and apply Item 200 mileage rule (use the min/max mileage-rate envelope if exact tariff table selection is not possible)
5. Adjust time for number of movers (diminishing returns) when estimating labor time
6. Provide a clear final estimate as a min/max range with the main assumptions stated

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

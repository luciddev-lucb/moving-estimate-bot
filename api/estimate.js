import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";

// Initialize Claude client
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

// Initialize Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res) {
  try {
    const { userId, clientInput } = req.body;

    // Get previous conversation (if any)
    let conversation = await redis.get(`movingbot:${userId}`) || [];

    // Add user message
    conversation.push({ role: "user", content: clientInput });

    // Claude system prompt
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
`;

    // Call Claude
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0.7,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: clientInput }]
        }
      ]
    });

    // Extract response text safely
    const reply = msg.content?.[0]?.text || "No response";

    // Save assistant reply
    conversation.push({ role: "assistant", content: reply });

    // Store in Redis with 2-hour expiration
    await redis.set(`movingbot:${userId}`, conversation, { ex: 7200 });

    // Return response
    res.status(200).json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

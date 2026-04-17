export const config = { runtime: "edge" };

export default function handler() {
  return Response.json({
    LLM_API_KEY: process.env.LLM_API_KEY ? "✓ set" : "✗ missing",
    LLM_BASE_URL: process.env.LLM_BASE_URL || "(not set — defaults to https://api.openai.com/v1)",
    LLM_MODEL: process.env.LLM_MODEL || "(not set — defaults to gpt-4o-mini)",
  });
}

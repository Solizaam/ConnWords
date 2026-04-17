export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!process.env.LLM_API_KEY) {
    return new Response("Server API key not configured", { status: 503 });
  }

  const body = await req.json();
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (process.env.LLM_MODEL) body.model = process.env.LLM_MODEL;

  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const detail = `${upstream.status} ${upstream.statusText} — ${text}`.slice(0, 400);
    return new Response(JSON.stringify({ error: detail }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

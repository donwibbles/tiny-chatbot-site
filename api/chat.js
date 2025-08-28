// /api/chat.js — simple general chatbot, Node-style (req, res)

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  if (!process.env.OPENAI_API_KEY) {
    res.statusCode = 500;
    return res.json({ error: "Missing OPENAI_API_KEY" });
  }

  // read body
  const body = await new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { resolve({}); }
    });
  });

  const message = body.message;
  if (!message) {
    res.statusCode = 400;
    return res.json({ error: "Missing message" });
  }

  const input = [
    { role: "system", content: [{ type: "input_text", text:
      "You are a concise, friendly website chatbot. Keep replies under 500 characters and avoid sensitive advice."
    }]},
    { role: "user", content: [{ type: "input_text", text: message }]}
  ];

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-4o-mini", input })
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("Responses API error:", t);
    res.statusCode = 500;
    return res.json({ error: "OpenAI error" });
  }

  const data = await r.json();

  let reply = null;
  if (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) {
    reply = data.output[0].content[0].text;
  } else if (data.output_text) {
    reply = data.output_text;
  }
  reply = reply?.slice(0, 500) || "Sorry—try again.";

  return res.json({ reply });
};

// /api/chat.js — General chatbot with Markdown + intent tags + logging (Node-style req/res)

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  if (!process.env.OPENAI_API_KEY) {
    res.statusCode = 500;
    return res.json({ error: "Missing OPENAI_API_KEY" });
  }

  // Read request body safely
  const body = await new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { resolve({}); }
    });
  });

  const { message, analytics } = body;
  if (!message) {
    res.statusCode = 400;
    return res.json({ error: "Missing message" });
  }

  // ---- Intent classifier (Step 2) ----
  async function classifyIntent(text) {
    const categories = [
      "pay","scheduling","leave","benefits","harassment_or_safety",
      "discipline_or_grievance","overtime","holidays","other"
    ];

    const input = [
      { role: "system", content: [{ type: "input_text", text:
        "You label user questions for routing. Return strict JSON only." }] },
      { role: "user", content: [{ type: "input_text", text:
        `Text: ${text}\n\nChoose category from ${JSON.stringify(categories)}.\n` +
        `Also detect: needs_human (boolean) if legal risk, discrimination, safety, emergency, or dispute; ` +
        `urgency ('low'|'normal'|'high'|'emergency'); ` +
        `pii_present (boolean) for full name/phone/address/SSN/identifiers.\n` +
        `Return JSON with keys: category, needs_human, urgency, pii_present.` }] }
    ];

    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input,
            response_format: { type: "json_object" }
          })
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      let txt = null;
      if (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) {
        txt = data.output[0].content[0].text;
      } else if (data.output_text) {
        txt = data.output_text;
      }
      return JSON.parse(txt || "{}");
    } catch (e) {
      console.error("classifyIntent error:", e);
      return { category: "other", needs_human: false, urgency: "low", pii_present: false };
    }
  }

  // Prompt: Markdown formatting
  const input = [
    { role: "system", content: [{ type: "input_text", text:
      "You are a concise, friendly website chatbot. Format responses in **Markdown** (use bullet points, bold, short headings). Keep replies under 500 characters. Avoid sensitive advice."
    }]},
    { role: "user", content: [{ type: "input_text", text: message }]}
  ];

  try {
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

    // ---- Tag + log (fire-and-forget) ----
    const tags = await classifyIntent(message);
    const logUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/log` : "/api/log";
    fetch(logUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", question: message, reply, tags, analytics: !!analytics })
    }).catch(() => {});

    return res.json({ reply });
  } catch (err) {
    console.error("General chat handler error:", err);
    res.statusCode = 500;
    return res.json({ error: "Server error" });
  }
};

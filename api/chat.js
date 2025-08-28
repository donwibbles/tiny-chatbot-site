// /api/chat.js — General chatbot with Markdown + intent tags + inline Sheets logging

// ---- Inline logger to Google Sheets ----
async function logToSheets(payload) {
  console.log("ANALYTICS:", JSON.stringify(payload));
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url || !payload.analytics) return;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error("Sheets webhook failed:", resp.status, text);
    } else {
      console.log("Sheets webhook ok:", resp.status, text);
    }
  } catch (e) {
    console.error("Sheets webhook error:", e);
  }
}

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

  // ---- Intent classifier (same as ask-cba) ----
  async function classifyIntent(text) {
    const categories = [
      "pay","scheduling","leave","benefits","harassment_or_safety",
      "discipline_or_grievance","overtime","holidays","other"
    ];

    const input = [
      { role: "system", content: [{ type: "input_text", text:
        "You are a labeling function. Output STRICT JSON only with keys: category, needs_human, urgency, pii_present. No prose, no markdown."
      }]},
      { role: "user", content: [{ type: "input_text", text:
        `Text: ${text}\n\n` +
        `Choose category from ${JSON.stringify(categories)}.\n` +
        `needs_human: boolean (true if legal risk, discrimination, safety, emergency, or strong dispute).\n` +
        `urgency: one of "low" | "normal" | "high" | "emergency".\n` +
        `pii_present: boolean (true if full name, phone, address, SSN, or precise identifiers are present).\n` +
        `Return ONLY a JSON object, nothing else.`
      }]}
    ];

    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-4o-mini", input, max_output_tokens: 150 })
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();

      let raw = null;
      if (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) {
        raw = data.output[0].content[0].text;
      } else if (data.output_text) {
        raw = data.output_text;
      }
      if (!raw) throw new Error("empty classifier output");
      const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      const obj = JSON.parse(cleaned);
      return {
        category: obj.category ?? "other",
        needs_human: !!obj.needs_human,
        urgency: obj.urgency ?? "low",
        pii_present: !!obj.pii_present
      };
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

    // ---- Tag + log (inline, awaited) ----
    const tags = await classifyIntent(message);
    await logToSheets({ mode: "general", question: message, reply, tags, analytics: !!analytics });

    return res.json({ reply });
  } catch (err) {
    console.error("General chat handler error:", err);
    res.statusCode = 500;
    return res.json({ error: "Server error" });
  }
};

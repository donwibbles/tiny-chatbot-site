// /api/ask-cba.js — Contract-grounded Q&A with intent tags + inline Sheets logging

const fs = require("node:fs");
const path = require("node:path");

// ---- Load your precomputed chunks once per cold start ----
// If your file lives in /data, change to: path.join(process.cwd(), "data", "cba_chunks.json")
let chunks = [];
try {
  const jsonPath = path.join(process.cwd(), "cba_chunks.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  chunks = JSON.parse(raw);
} catch (e) {
  console.error("Could not load cba_chunks.json:", e);
}

// ---- Helpers ----
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedQuery(q) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: q })
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.data?.[0]?.embedding || null;
}

async function readJsonBody(req) {
  return await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); }
    });
  });
}

// ---- Intent classifier (no response_format) ----
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

// ---- Inline logger to Google Sheets (no internal HTTP call) ----
async function logToSheets(payload) {
  console.log("ANALYTICS:", JSON.stringify(payload));
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url || !payload.analytics) return; // skip if not enabled or URL missing

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

// ---- Main handler ----
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  if (!process.env.OPENAI_API_KEY) {
    res.statusCode = 500;
    return res.json({ error: "Missing OPENAI_API_KEY" });
  }

  if (!chunks?.length) {
    res.statusCode = 500;
    return res.json({ error: "No CBA data found on server (cba_chunks.json missing?)" });
  }

  const { question, analytics } = await readJsonBody(req);
  if (!question) {
    res.statusCode = 400;
    return res.json({ error: "Missing question" });
  }

  // 1) Embed the user query
  const qvec = await embedQuery(question);
  if (!qvec) {
    res.statusCode = 500;
    return res.json({ error: "Embedding failed" });
  }

  // 2) Rank chunks by similarity
  const scored = chunks.map(c => ({ ...c, score: cosine(qvec, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 8);
  const context = top.map(c => c.text).join("\n\n");

  // 3) Build prompt (allow translate/summarize/bullets)
  const allowTransform =
    /translate|traduce|traducir|summarize|resumen|bullet|format/i.test(question);

  const systemText =
    "You are a contract assistant grounded ONLY in the provided contract excerpts. " +
    "You MAY quote, summarize, restructure, or TRANSLATE the provided excerpts if requested. " +
    "Do NOT add information that is not explicitly present in the excerpts. " +
    "If something is not in the excerpts, say 'not sure'. " +
    "Format responses in **Markdown** (headings, bullets, bold). " +
    "Keep answers under 600 characters. This is general info, not legal advice.";

  const userText =
    `CONTRACT EXCERPTS:\n${context}\n\n` +
    `TASK: ${allowTransform ? "Translate/summarize/reformat if requested, otherwise answer directly." : "Answer directly from the excerpts."}\n` +
    `QUESTION: ${question}`;

  const input = [
    { role: "system", content: [{ type: "input_text", text: systemText }] },
    { role: "user",   content: [{ type: "input_text", text: userText }] }
  ];

  // 4) Call OpenAI
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
    console.error("OpenAI error:", t);
    res.statusCode = 500;
    return res.json({ error: "OpenAI request failed" });
  }

  const data = await r.json();

  let reply = null;
  if (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) {
    reply = data.output[0].content[0].text;
  } else if (data.output_text) {
    reply = data.output_text;
  }
  reply = reply?.slice(0, 600) || "Sorry, I could not generate a reply.";

  // 5) Tag + log (inline)
  const tags = await classifyIntent(question);
  await logToSheets({ mode: "cba", question, reply, tags, analytics: !!analytics });

  return res.json({ reply });
};

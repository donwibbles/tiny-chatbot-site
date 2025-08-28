// /api/ask-cba.js  — Node-style Vercel Function (req, res). No JSON import attrs.

const fs = require("node:fs");
const path = require("node:path");

// ---- Load your JSON once at cold start (from repo root) ----
let chunks = [];
try {
  const jsonPath = path.join(process.cwd(), "cba_chunks.json"); // change to ["data","cba_chunks.json"] if you put it in /data
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

// Parse JSON body from Node req (works regardless of body parser)
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

// ---- Handler ----
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain");
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

  const { question } = await readJsonBody(req);
  if (!question) {
    res.statusCode = 400;
    return res.json({ error: "Missing question" });
  }

  const qvec = await embedQuery(question);
  if (!qvec) {
    res.statusCode = 500;
    return res.json({ error: "Embedding failed" });
  }

  const scored = chunks.map(c => ({ ...c, score: cosine(qvec, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const context = top.map(c => c.text).join("\n\n");
  const prompt = [
    { role: "system", content: [{ type: "text", text:
      "You are a contract assistant. Answer ONLY from the provided contract excerpts. If unsure, say 'not sure.' Keep answers under 600 characters. This is general info, not legal advice."
    }]},
    { role: "user", content: [{ type: "text", text:
      `CONTRACT:\n${context}\n\nQUESTION: ${question}`
    }]}
  ];

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-4o-mini", input: prompt })
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("OpenAI error:", t);
    res.statusCode = 500;
    return res.json({ error: "OpenAI request failed" });
  }

  const data = await r.json();
  const reply = data.output_text?.slice(0, 600) || "Sorry—try again.";
  return res.json({ reply });
};

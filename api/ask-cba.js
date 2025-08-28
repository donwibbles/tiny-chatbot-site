// /api/ask-cba.js
// Loads cba_chunks.json with fs (no JSON import attributes), then does simple RAG.

import fs from "node:fs";
import path from "node:path";

// --- Load the JSON once at cold start ---
let chunks;
try {
  // process.cwd() points at the project root in Vercel Functions
  const jsonPath = path.join(process.cwd(), "cba_chunks.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  chunks = JSON.parse(raw);
} catch (e) {
  console.error("Failed to load cba_chunks.json:", e);
  chunks = []; // keep server from crashing; we’ll error later if empty
}

// --- Utilities ---
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
  if (!r.ok) {
    const t = await r.text();
    console.error("Embedding error:", t);
    return null;
  }
  const data = await r.json();
  return data.data?.[0]?.embedding || null;
}

// --- Function handler ---
export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY env var" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  if (!chunks?.length) {
    return new Response(JSON.stringify({ error: "CBA data not found on server" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const { question } = await request.json().catch(() => ({}));
  if (!question) {
    return new Response(JSON.stringify({ error: "Missing question" }), {
      status: 400, headers: { "content-type": "application/json" }
    });
  }

  // 1) Embed the user question
  const qvec = await embedQuery(question);
  if (!qvec) {
    return new Response(JSON.stringify({ error: "Embedding failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  // 2) Rank chunks by cosine similarity
  const scored = chunks.map(c => ({ ...c, score: cosine(qvec, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  // 3) Build the prompt from top chunks
  const context = top.map(c => c.text).join("\n\n");
  const prompt = [
    { role: "system", content: [{ type: "text", text:
      "You are a contract assistant. Answer ONLY from the provided contract excerpts. If unsure, say \"not sure.\" Keep answers under 600 characters. This is general info, not legal advice."
    }]},
    { role: "user", content: [{ type: "text", text:
      `CONTRACT:\n${context}\n\nQUESTION: ${question}`
    }]}
  ];

  // 4) Ask OpenAI
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
    console.error("Responses API error:", t);
    return new Response(JSON.stringify({ error: "OpenAI error" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const data = await r.json();
  const reply = data.output_text?.slice(0, 600) || "Sorry—try again.";

  return new Response(JSON.stringify({ reply }), {
    headers: { "content-type": "application/json" }
  });
}

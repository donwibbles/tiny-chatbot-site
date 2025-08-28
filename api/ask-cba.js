// /api/ask-cba.js
// Load cba_chunks.json without using JSON import attributes

import fs from "node:fs";
import path from "node:path";

// --- Load the JSON once when the function starts ---
let chunks = [];
try {
  const jsonPath = path.join(process.cwd(), "cba_chunks.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  chunks = JSON.parse(raw);
} catch (e) {
  console.error("Could not load cba_chunks.json:", e);
}

// --- Cosine similarity helper ---
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Create embedding for a query ---
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

// --- API handler ---
export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { question } = await request.json().catch(() => ({}));
  if (!question) {
    return new Response(JSON.stringify({ error: "Missing question" }), {
      status: 400, headers: { "content-type": "application/json" }
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing API key" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  if (!chunks?.length) {
    return new Response(JSON.stringify({ error: "No CBA data found" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  // Embed question
  const qvec = await embedQuery(question);
  if (!qvec) {
    return new Response(JSON.stringify({ error: "Embedding failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  // Rank top 5 chunks
  const scored = chunks.map(c => ({ ...c, score: cosine(qvec, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  // Build prompt
  const context = top.map(c => c.text).join("\n\n");
  const prompt = [
    { role: "system", content: [{ type: "text", text:
      "You are a contract assistant. Answer ONLY from the provided contract excerpts. If unsure, say 'not sure.' Keep answers under 600 characters. This is general info, not legal advice." }] },
    { role: "user", content: [{ type: "text", text:
      `CONTRACT:\n${context}\n\nQUESTION: ${question}` }] }
  ];

  // Call OpenAI
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
    return new Response(JSON.stringify({ error: "OpenAI request failed" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }

  const data = await r.json();
  const reply = data.output_text?.slice(0, 600) || "Sorry—try again.";

  return new Response(JSON.stringify({ reply }), {
    headers: { "content-type": "application/json" }
  });
}

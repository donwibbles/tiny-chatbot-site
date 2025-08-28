// /api/log.js — receives message metadata and forwards it (console + optional Google Sheets)

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405; return res.end("Method Not Allowed");
  }

  // read body
  const body = await new Promise((resolve) => {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }});
  });

  // Prepare payload
  const payload = {
    ts: new Date().toISOString(),
    mode: body.mode || "unknown",
    question: String(body.question || "").slice(0, 2000),
    reply: String(body.reply || "").slice(0, 2000),
    tags: body.tags || {},
    analytics: !!body.analytics
  };

  // Always log to console (visible in Vercel function logs)
  console.log("ANALYTICS:", JSON.stringify(payload));

  // Optional: forward to Google Sheets Apps Script
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (url && payload.analytics) {
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

  res.json({ ok: true });
};

// /api/log.js — receives message metadata and forwards it.
// Configure SHEETS_WEBHOOK_URL in Vercel if you want Google Sheets logging.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405; return res.end("Method Not Allowed");
  }

  // read body
  const body = await new Promise((resolve) => {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }});
  });

  // Basic shape validation
  const payload = {
    ts: new Date().toISOString(),
    mode: body.mode || "unknown",
    question: String(body.question || "").slice(0, 2000),
    reply: String(body.reply || "").slice(0, 2000),
    tags: body.tags || {},
    analytics: !!body.analytics,
    // minimal IP info only if you later use edge; keeping it off for privacy
  };

  // 1) Always log to console (visible in Vercel function logs)
  console.log("ANALYTICS:", JSON.stringify(payload));

  // 2) Optional: forward to Google Sheets (Apps Script → web app URL in env)
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (url && payload.analytics) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("Sheets webhook failed:", e);
    }
  }

  res.json({ ok: true });
};

// Vercel Function using the Web Request/Response API
export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { message } = await request.json().catch(() => ({}));
  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing message' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: [
          { role: 'system', content: [{ type: 'text', text: 'You are a concise, friendly website chatbot. Keep replies under 500 characters and avoid sensitive advice.' }] },
          { role: 'user',   content: [{ type: 'text', text: message }] }
        ]
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return new Response(JSON.stringify({ error: 'OpenAI error', details: errText }), {
        status: 500, headers: { 'content-type': 'application/json' }
      });
    }

    const data = await r.json();

    // Prefer output_text if present; otherwise assemble text from output items.
    let reply = data.output_text;
    if (!reply) {
      const items = Array.isArray(data.output) ? data.output : [];
      const texts = [];
      for (const it of items) {
        if (it?.content) {
          for (const c of it.content) {
            if (c.type === 'output_text' || c.type === 'text') {
              texts.push(c.text);
            }
          }
        }
      }
      reply = texts.join(' ').trim();
    }
    reply = (reply || 'Sorry—try again.').slice(0, 500);

    return new Response(JSON.stringify({ reply }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
}

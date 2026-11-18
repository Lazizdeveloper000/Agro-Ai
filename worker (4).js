// Cloudflare Worker — Gemini API kalitini yashirib turuvchi proxy.
// Kalit saytda emas, serverda (Worker "Secret" sifatida) saqlanadi.
//
// Sozlash:
//   1) Cloudflare Dashboard → Workers & Pages → Create Worker → shu kodni qo'ying
//   2) Settings → Variables and Secrets:
//        GEMINI_API_KEY  (Secret)  = Google AI Studio kalitingiz
//        ALLOWED_ORIGIN  (Text)    = saytingiz manzili, masalan https://agroai.uz  (ixtiyoriy, lekin tavsiya etiladi)
//   3) Worker manzilini index.html dagi CONFIG.PROXY_URL ga yozing

// Faqat Gemini modellariga ruxsat (model nomi o'zgarsa ham ishlayveradi)
const MODEL_RE = /^gemini-[a-z0-9.\-]+$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : '*';

    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response('Bad JSON', { status: 400, headers: cors });
    }

    const model = payload.model;
    if (typeof model !== 'string' || !MODEL_RE.test(model) || !payload.body) {
      return new Response('Bad request', { status: 400, headers: cors });
    }

    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY
        },
        body: JSON.stringify(payload.body)
      }
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
};

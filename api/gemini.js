// Vercel Serverless Function: /api/gemini
// API kalit faqat Vercel Environment Variables (GEMINI_API_KEY) ichida saqlanadi.
// GitHub'da ham, brauzerda ham HECH QACHON ko'rinmaydi!

const FALLBACK_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash'
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function stripResponseSchema(body) {
    if (!body || !body.generationConfig || !body.generationConfig.responseSchema) return null;
    const copy = JSON.parse(JSON.stringify(body));
    delete copy.generationConfig.responseSchema;
    return copy;
}

function extractText(json) {
    if (json && json.promptFeedback && json.promptFeedback.blockReason) {
        const err = new Error('BLOCKED');
        err.code = 'BLOCKED';
        err.detail = json.promptFeedback.blockReason;
        throw err;
    }
    const cand = json && json.candidates && json.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim();
    if (!text) {
        const err = new Error('EMPTY');
        err.code = 'EMPTY';
        throw err;
    }
    return text;
}

async function discoverFlashModels(apiKey) {
    try {
        const res = await fetchWithTimeout(
            'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
            { headers: { 'x-goog-api-key': apiKey } },
            6000
        );
        if (!res.ok) return [];
        const data = await res.json();
        const names = (data.models || [])
            .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map((m) => m.name.replace(/^models\//, ''));
        const flash = names.filter(
            (n) =>
                /^gemini-\d+(\.\d+)?-flash/.test(n) &&
                !/(image|tts|live|audio|thinking|robotics|embedding|customtools)/.test(n)
        );
        const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
        flash.sort((a, b) => (ver(b) - ver(a)) || ((/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0)));
        return flash;
    } catch (_) {
        return [];
    }
}

async function postToGemini(model, body, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body)
        },
        22000
    );
}

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Faqat POST so'roviga ruxsat beriladi." });
    }

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return res.status(500).json({
            code: 'SERVER_NO_KEY',
            error: "Vercel serverida GEMINI_API_KEY sozlanmagan. Vercel -> Settings -> Environment Variables bo'limiga GEMINI_API_KEY qo'shing va Redeploy qiling."
        });
    }

    let payload = req.body;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (_) {
            return res.status(400).json({ error: "Noto'g'ri JSON formati." });
        }
    }

    const body = payload && payload.body;
    if (!body || !Array.isArray(body.contents)) {
        return res.status(400).json({ error: "So'rov tarkibi noto'g'ri." });
    }

    let queue = [...FALLBACK_MODELS];
    let discovered = false;
    let lastStatus = 500;
    let lastDetail = '';

    for (let i = 0; i < queue.length; i++) {
        const model = queue[i];
        let upstream;
        try {
            upstream = await postToGemini(model, body, apiKey);
        } catch (err) {
            lastStatus = err && err.name === 'AbortError' ? 504 : 502;
            lastDetail = err && err.name === 'AbortError' ? 'Model timeout' : 'Network error';
            continue;
        }

        if (upstream.status === 400) {
            const noSchema = stripResponseSchema(body);
            if (noSchema) {
                try {
                    const retryRes = await postToGemini(model, noSchema, apiKey);
                    if (retryRes.ok) upstream = retryRes;
                } catch (_) {}
            }
        }

        if (upstream.ok) {
            try {
                const json = await upstream.json();
                const text = extractText(json);
                return res.status(200).json({ text, model });
            } catch (parseErr) {
                if (parseErr && parseErr.code === 'BLOCKED') {
                    return res.status(422).json({
                        code: 'BLOCKED',
                        error: "So'rov xavfsizlik filtri tomonidan rad etildi. Iltimos, aniqroq o'simlik rasmini yuklang."
                    });
                }
                lastStatus = 502;
                lastDetail = 'Empty model output';
                continue;
            }
        }

        lastStatus = upstream.status;
        try {
            const errJson = await upstream.json();
            lastDetail = ((errJson.error && errJson.error.message) || '').slice(0, 220);
        } catch (_) {
            lastDetail = '';
        }

        if (upstream.status === 401 || upstream.status === 403) {
            return res.status(upstream.status).json({
                code: 'INVALID_KEY',
                error: "Serverdagi GEMINI_API_KEY yaroqsiz yoki ruxsati yo'q. Yangi kalitni Vercel sozlamasiga kiriting.",
                detail: lastDetail
            });
        }

        if (!discovered && (upstream.status === 404 || upstream.status === 503 || upstream.status === 429)) {
            discovered = true;
            const extra = await discoverFlashModels(apiKey);
            for (const m of extra) {
                if (!queue.includes(m)) queue.push(m);
            }
        }

        if (i < queue.length - 1) {
            await sleep(350);
        }
    }

    return res.status(lastStatus || 503).json({
        code: lastStatus === 429 ? 'RATE_LIMIT' : 'UPSTREAM_BUSY',
        error:
            lastStatus === 429
                ? "So'rovlar limiti vaqtincha tugadi. 30-60 soniyadan keyin qayta urinib ko'ring."
                : "Google Gemini serverlari hozir vaqtincha band. Bir necha soniyadan keyin «Qayta urinish» tugmasini bosing.",
        detail: lastDetail
    });
};
// Vercel Serverless Function — Google Gemini AI Backend (API kalit 100% yashirin)
// API kalit faqat serverdagi GEMINI_API_KEY environment variable orqali o'qiladi.

const MODELS = [
    'gemini-flash-lite-latest',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-3.8-flash'
];

const DIAG_PROMPT = `Sen tajribali o'zbek agronomi va o'simlik kasalliklari (fitopatologiya) bo'yicha mutaxassissan.
Senga bitta rasm berildi. Avval rasmda HAQIQIY o'simlik bor-yo'qligini qat'iy tekshir, keyin tashxis qo'y.

QAT'IY QOIDALAR:
1. O'SIMLIK EMAS FILTRI (ENG MUHIM):
   Agar rasmdagi asosiy obyekt o'simlik (barg, poya, ildiz, gul, meva/sabzavot ekinlari, daraxt, ekin maydoni) BO'LMASA — masalan: avtomobil/moshina, mototsikl, odam, yuz, hayvon, bino, mebel, telefon, kompyuter ekrani, skrinshot, matn/hujjat, pishirilgan taom, multfilm/chizma, bo'sh fon va h.k. —
   ALBATTA "is_plant": false qil!
   - "detected_object" maydoniga rasmda aslida nima borligini qisqacha o'zbekcha yoz (masalan: "Avtomobil (moshina)", "Odam surati", "Hujjat/matn", "Mushuk").
   - "not_plant_reason" maydoniga aniq tushuntirish yoz (masalan: "Bu rasmda o'simlik emas, balki avtomobil tasvirlangan. AGRO-AI faqat o'simlik va ekin barglarini tekshiradi.").

2. SIFAT FILTRI:
   Agar rasmda o'simlik bo'lsa-yu, lekin rasm juda xira, qorong'i yoki uzoqdan olingan bo'lib, kasallikni aniqlab bo'lmasa —
   "is_plant": true, "image_quality_ok": false qil va "not_plant_reason" maydonida tushuntir.

3. HAQIQIY TASHXIS (agar aniq o'simlik bo'lsa):
   - "is_plant": true, "image_quality_ok": true
   - "is_healthy": sog'lom bo'lsa true, kasal/zararlangan bo'lsa false
   - "plant_name": o'simlik nomi o'zbekcha (masalan: "Pomidor", "Bodring", "Bug'doy")
   - "disease_name": kasallik/zararkunanda nomi (masalan: "Un shudring (Powdery Mildew)", "Fitoftoroz (Late Blight)") yoki "Sog'lom — kasallik aniqlanmadi"
   - "confidence": 0 dan 100 gacha butun son
   - "severity": faqat bittasi: "yo'q", "yengil", "o'rta", "og'ir"
   - "symptoms": rasmda ko'ringan belgilar (batafsil va tushunarli)
   - "causes": kasallik kelib chiqish sababi
   - "treatment": O'zbekistonda topiladigan dorilar (Topaz, Ridomil Gold, Skor, Quadris, Bordo suyuqligi, Aktara va h.k.), taxminiy me'yor, organik usul va yorliqqa amal qilish eslatmasi
   - "irrigation": sug'orish, namlik va shamollatish maslahati
   - "fertilizer_prevention": o'g'itlash va profilaktika choralari

JAVOB FORMATI: Barcha matnlar O'ZBEK tilida (lotin yozuvida) bo'lsin. Hech qanday ortiqcha matn yozma, FAQAT quyidagi strukturadagi toza JSON qaytar:
{
  "is_plant": true,
  "image_quality_ok": true,
  "detected_object": "...",
  "not_plant_reason": "",
  "is_healthy": false,
  "plant_name": "...",
  "disease_name": "...",
  "confidence": 85,
  "severity": "o'rta",
  "symptoms": "...",
  "causes": "...",
  "treatment": "...",
  "irrigation": "...",
  "fertilizer_prevention": "..."
}`;

const CHAT_SYSTEM_PROMPT = `Sen "AGRO-AI Bosh Agronom" — O'zbekiston fermerlari va dehqonlariga yordam beradigan tajribali agronomsan.

QOIDALAR:
- Faqat o'zbek tilida (lotin yozuvida) javob ber. Foydalanuvchi boshqa tilda yozsa ham, tushunarli o'zbek tilida javob ber.
- Faqat qishloq xo'jaligi mavzulariga javob ber: ekinlar, o'simlik kasalliklari va zararkunandalari, dorilar, o'g'itlar, sug'orish, tuproq, issiqxona, bog'dorchilik, chorvachilik ozuqasi, hosil va uning iqtisodi, ob-havoning ekinga ta'siri.
- Salomlashuvga va "qalaysiz" kabi muloyim gaplarga qisqa, iliq javob ber va qanday yordam bera olishingni ayt.
- Mavzudan tashqari savollarga (siyosat, dasturlash, kino, mashina, matematika uy vazifasi va h.k.) javob berma. Muloyim qilib: "Men faqat qishloq xo'jaligi va o'simliklar bo'yicha yordam bera olaman" de va agronomik savol berishga taklif qil.
- Javoblar aniq, amaliy va tushunarli bo'lsin: qisqa sarlavha, raqamlangan qadamlar yoki qisqa ro'yxat ishlat.
- Dori tavsiya qilganda preparat nomi, taxminiy me'yori va qachon/qanday sepilishini ayt, hamda "yorliqdagi ko'rsatmaga amal qiling, himoya vositalaridan foydalaning" deb eslat.
- Aniq bilmagan narsangni o'ylab topma. Kerak bo'lsa 1-2 ta aniqlashtiruvchi savol ber.
- Og'ir holatlarda mahalliy agronomga murojaat qilishni maslahat ber.`;

function getEndpointsForModel(model, apiKey) {
    const key = apiKey.trim();
    const glUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    if (key.startsWith('AQ.')) {
        return [
            glUrl,
            `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`
        ];
    }
    return [glUrl];
}

function extractTextFromResponse(data) {
    const candidates = data && data.candidates;
    if (!Array.isArray(candidates) || !candidates.length) return '';
    const parts = candidates[0] && candidates[0].content && candidates[0].content.parts;
    if (!Array.isArray(parts)) return '';
    return parts
        .filter((p) => p && !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim();
}

function extractJsonSafe(rawText) {
    const cleaned = String(rawText || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1));
        }
        throw new Error('INVALID_JSON');
    }
}

async function callGeminiWithFallback(payload, apiKey) {
    let lastStatus = 500;
    let lastDetail = '';

    for (const model of MODELS) {
        const urls = getEndpointsForModel(model, apiKey);
        for (const url of urls) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);

            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey.trim()
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timer);

                const data = await resp.json().catch(() => ({}));
                if (resp.ok) {
                    const text = extractTextFromResponse(data);
                    if (text) {
                        return { text, model };
                    }
                    lastDetail = 'Empty response from model';
                    continue;
                }

                lastStatus = resp.status;
                lastDetail = (data && data.error && data.error.message) || `HTTP ${resp.status}`;

                if (resp.status === 404) {
                    break;
                }
            } catch (err) {
                clearTimeout(timer);
                lastStatus = 504;
                lastDetail = err && err.message ? err.message : 'Network error';
            }
        }
    }

    const error = new Error(lastDetail || 'Gemini request failed');
    error.status = lastStatus;
    throw error;
}

function parseBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch (_) {
            return {};
        }
    }
    return req.body;
}

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
    }

    if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end(JSON.stringify({ error: "Faqat POST so'rovlar qabul qilinadi." }));
    }

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        res.statusCode = 500;
        return res.end(JSON.stringify({
            error: "Serverda GEMINI_API_KEY sozlanmagan. Vercel → Settings → Environment Variables bo'limiga GEMINI_API_KEY qo'shing va qayta deploy qiling."
        }));
    }

    const body = parseBody(req);
    const action = body.action;

    try {
        if (action === 'diagnose') {
            const rawImage = String(body.imageDataUrl || '');
            const match = rawImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
            if (!match) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "Noto'g'ri rasm formati yuborildi." }));
            }

            const mimeType = match[1];
            const base64Data = match[2];

            if (base64Data.length > 8 * 1024 * 1024) {
                res.statusCode = 413;
                return res.end(JSON.stringify({ error: "Rasm hajmi juda katta. Kichikroq rasm yuklang." }));
            }

            const payload = {
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: DIAG_PROMPT },
                            {
                                inlineData: {
                                    mimeType,
                                    data: base64Data
                                }
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    responseMimeType: 'application/json'
                }
            };

            const { text, model } = await callGeminiWithFallback(payload, apiKey);
            const diagnosis = extractJsonSafe(text);

            res.statusCode = 200;
            return res.end(JSON.stringify({ ok: true, model, diagnosis }));
        }

        if (action === 'chat') {
            const history = Array.isArray(body.history) ? body.history.slice(-24) : [];
            const contents = [];

            for (const msg of history) {
                if (!msg || !msg.content) continue;
                const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
                const text = String(msg.content).trim().slice(0, 4000);
                if (!text) continue;
                if (contents.length > 0 && contents[contents.length - 1].role === role) {
                    contents[contents.length - 1].parts[0].text += '\n' + text;
                } else {
                    contents.push({ role, parts: [{ text }] });
                }
            }

            while (contents.length > 0 && contents[0].role !== 'user') {
                contents.shift();
            }

            if (!contents.length) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "Xabar matni bo'sh." }));
            }

            const payload = {
                systemInstruction: {
                    parts: [{ text: CHAT_SYSTEM_PROMPT }]
                },
                contents,
                generationConfig: {
                    temperature: 0.6,
                    maxOutputTokens: 1600
                }
            };

            const { text, model } = await callGeminiWithFallback(payload, apiKey);
            res.statusCode = 200;
            return res.end(JSON.stringify({ ok: true, model, reply: text }));
        }

        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "Noto'g'ri action turi." }));
    } catch (err) {
        const status = err && err.status;
        let userMsg = "Gemini AI bilan bog'lanishda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.";

        if (status === 401 || status === 403) {
            userMsg = "Gemini API kaliti noto'g'ri yoki ruxsati yo'q. Vercel Environment Variables dagi GEMINI_API_KEY ni tekshiring.";
        } else if (status === 429) {
            userMsg = "So'rovlar limiti vaqtincha tugadi. 20–30 soniyadan keyin qayta urinib ko'ring.";
        } else if (err && err.message === 'INVALID_JSON') {
            userMsg = "AI javobini o'qib bo'lmadi. «Qayta urinish» tugmasini bosing.";
        }

        console.error('Gemini API error:', status, err && err.message);
        res.statusCode = status && status >= 400 && status < 600 ? status : 500;
        return res.end(JSON.stringify({ error: userMsg }));
    }
};
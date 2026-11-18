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
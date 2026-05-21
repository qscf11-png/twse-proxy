// Vercel Serverless Function — 達哥 GAISF API 反向代理
// 路由: POST /api/gaisf?path=/openai/deployments/gpt-4o-mini/chat/completions&api-version=2024-10-21

const GAISF_ORIGIN = 'https://moxaingress-gaisf-ingress.azurewebsites.net';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api-key');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const deployPath = req.query.path;
    if (!deployPath) {
        return res.status(400).json({ error: '缺少 path 參數，格式: ?path=/openai/deployments/{model}/chat/completions&api-version=...' });
    }

    const apiVersion = req.query['api-version'] || '2024-10-21';
    const targetUrl = `${GAISF_ORIGIN}${deployPath}?api-version=${apiVersion}`;

    const apiKey = req.headers['api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: '缺少 api-key header' });
    }

    try {
        const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
            },
            body: JSON.stringify(req.body),
        });

        const data = await upstream.json();

        if (!upstream.ok) {
            return res.status(upstream.status).json(data);
        }

        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(502).json({ error: `GAISF 代理失敗: ${err.message}` });
    }
}

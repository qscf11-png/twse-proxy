// Vercel Serverless Function — 達哥 GAISF API 反向代理
// 路由: POST /api/gaisf?path=/openai/deployments/gpt-4o-mini/chat/completions&api-version=2024-10-21
// 認證:
//   - 一般模型（chat/completions）: api-key header
//   - Nanobanana（images/generations）: Authorization header（無 Bearer 前綴）

const GAISF_ORIGIN = 'https://moxaingress-gaisf-ingress.azurewebsites.net';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api-key, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const deployPath = req.query.path;
    if (!deployPath) {
        return res.status(400).json({ error: '缺少 path 參數，格式: ?path=/openai/deployments/{model}/chat/completions&api-version=...' });
    }

    // api-version 僅在呼叫端明確指定時附加（nanobanana 等端點不需要）
    const apiVersion = req.query['api-version'];
    const targetUrl = apiVersion
        ? `${GAISF_ORIGIN}${deployPath}?api-version=${apiVersion}`
        : `${GAISF_ORIGIN}${deployPath}`;

    // 轉發呼叫端提供的認證 header（api-key 或 Authorization 擇一即可）
    const apiKey = req.headers['api-key'];
    const authHeader = req.headers['authorization'];
    if (!apiKey && !authHeader) {
        return res.status(401).json({ error: '缺少 api-key 或 Authorization header' });
    }

    const upstreamHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) upstreamHeaders['api-key'] = apiKey;
    if (authHeader) upstreamHeaders['Authorization'] = authHeader;

    try {
        const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: upstreamHeaders,
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

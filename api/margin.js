// Vercel Serverless Function — TWSE 融資融券 (MI_MARGN) 代理
// 路由: GET /api/margin
// 於伺服器端抓取 TWSE OpenAPI「最新交易日」全上市個股融資融券餘額，
// 並附上 CORS 標頭回傳給前端（OpenAPI 本身未提供 CORS，故需此代理）。

export default async function handler(req, res) {
    // CORS 標頭
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const twseUrl = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN';
        const twseResp = await fetch(twseUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
            },
        });

        if (!twseResp.ok) {
            return res.status(twseResp.status).json({ error: 'TWSE OpenAPI error' });
        }

        const data = await twseResp.json();

        // 融資融券資料每日盤後才更新一次，快取 30 分鐘（並允許背景重取）
        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

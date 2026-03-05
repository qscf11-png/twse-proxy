// Vercel Serverless Function — TWSE MIS API 代理
// 路由: GET /api/stock?ex_ch=tse_2330.tw|otc_3081.tw

export default async function handler(req, res) {
    // CORS 標頭
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const exCh = req.query.ex_ch;
    if (!exCh) {
        return res.status(400).json({ error: 'Missing ex_ch parameter' });
    }

    try {
        const twseUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(exCh)}&_=${Date.now()}`;

        const twseResp = await fetch(twseUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
                'Accept': 'application/json',
            },
        });

        if (!twseResp.ok) {
            return res.status(twseResp.status).json({ error: 'TWSE API error' });
        }

        const data = await twseResp.json();

        // 快取 5 秒，避免過度請求 TWSE
        res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

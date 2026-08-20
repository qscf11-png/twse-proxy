// Vercel Serverless Function — 個股歷史日 K 代理（Yahoo Finance）
// 路由: GET /api/history?symbol=2330&range=1y
// 於伺服器端抓 Yahoo Finance 日線（先試 .TW 再試 .TWO），回傳精簡的收盤序列。
// 回傳格式：{ symbol, history: [{ date: "YYYY-MM-DD", close: number }] }

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
};

const fetchYahoo = async (symbol, suffix, range) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?interval=1d&range=${range}`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return null;
    const data = await resp.json();
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const vols = q.volume || [];
    const history = [];
    for (let i = 0; i < ts.length; i++) {
        const close = closes[i];
        if (close == null || close <= 0) continue;
        // high/low/volume 供型態判定與大量區間低點計算（缺值以收盤價/0 補）
        history.push({
            date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
            close,
            high: highs[i] > 0 ? highs[i] : close,
            low: lows[i] > 0 ? lows[i] : close,
            volume: vols[i] > 0 ? vols[i] : 0,
        });
    }
    return history.length > 0 ? history : null;
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const symbol = String(req.query.symbol || '').trim();
    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }
    // 指數（^TWII 加權、^TWOII 櫃買）不加 .TW/.TWO 後綴，直接查詢
    if (symbol.startsWith('^')) {
        try {
            const range = ['1mo', '3mo', '6mo', '1y', '2y', '5y'].includes(req.query.range) ? req.query.range : '6mo';
            const history = await fetchYahoo(symbol, '', range);
            if (!history) return res.status(200).json({ symbol, history: [] });
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
            return res.status(200).json({ symbol, history });
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }
    // 限制 range 白名單，避免濫用
    const allowed = ['1mo', '3mo', '6mo', '1y', '2y', '5y'];
    const range = allowed.includes(req.query.range) ? req.query.range : '1y';

    try {
        let history = await fetchYahoo(symbol, '.TW', range);
        if (!history) history = await fetchYahoo(symbol, '.TWO', range);
        if (!history) {
            return res.status(200).json({ symbol, history: [] });
        }
        // 歷史日線每日僅更新一次，快取 1 小時
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({ symbol, history });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

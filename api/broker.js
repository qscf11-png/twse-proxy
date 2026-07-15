// Vercel Serverless Function — 單一券商對個股的每日買賣超（分點資料）
// 路由: GET /api/broker?stockNo=2330&bhid=9800
// 來源: 富邦 e01 (MoneyDJ) 券商歷史明細頁 zco0.djhtm（Big5 編碼，
// 但日期與數字皆為 ASCII，以 latin1 讀取後用正則解析即可）。
// 預設 bhid=9800（元大證券，散戶指標券商）。單位：張。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const toInt = (s) => parseInt(String(s).replace(/,/g, ''), 10) || 0;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const stockNo = String(req.query.stockNo || '').trim();
    if (!/^[0-9A-Za-z]{4,6}$/.test(stockNo)) {
        return res.status(400).json({ error: 'invalid stockNo' });
    }
    const bhid = /^\d{3,4}$/.test(String(req.query.bhid || '')) ? String(req.query.bhid) : '9800';

    try {
        const url = `https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco0/zco0.djhtm?a=${stockNo}&b=${bhid}&BHID=${bhid}`;
        const resp = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!resp.ok) return res.status(502).json({ error: 'source fetch failed' });

        // Big5 頁面：以 latin1 保留位元組，日期/數字為 ASCII 可直接正則解析
        const buf = Buffer.from(await resp.arrayBuffer());
        const html = buf.toString('latin1');

        // 資料列：日期 | 買進(張) | 賣出(張) | 買賣總額(張) | 買賣超(張)
        const rows = [];
        const re = /<td[^>]*>(\d{4}\/\d{2}\/\d{2})<\/td>\s*<td[^>]*>([\d,]+)<\/td>\s*<td[^>]*>([\d,]+)<\/td>\s*<td[^>]*>([\d,]+)<\/td>\s*<td[^>]*>(-?[\d,]+)<\/td>/g;
        let m;
        while ((m = re.exec(html)) !== null && rows.length < 15) {
            rows.push({
                date: m[1].replace(/\//g, '-'),
                buy: toInt(m[2]),
                sell: toInt(m[3]),
                net: toInt(m[5]),
            });
        }

        // 每日盤後更新，快取 30 分鐘
        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
        return res.status(200).json({ stockNo, bhid, days: rows });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

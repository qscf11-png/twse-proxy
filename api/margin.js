// Vercel Serverless Function — 融資融券 (上市 + 上櫃) 合併代理
// 路由: GET /api/margin
// 於伺服器端同時抓取：
//   - TWSE OpenAPI  MI_MARGN                     （上市集中市場）
//   - TPEx OpenAPI  tpex_mainboard_margin_balance（上櫃店頭市場）
// 正規化為統一格式後附 CORS 標頭回傳。單位皆為「張」。
// 回傳格式：{ date: "YYYYMMDD", list: [{ code, name, market, mPrev, mToday, sPrev, sToday, sRedeem }] }

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
};

// 字串轉整數（去千分位逗號、空字串視為 0）
const toInt = (s) => {
    if (s == null || s === '') return 0;
    const n = parseInt(String(s).replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
};

// 民國日期 "1150706" → 西元 "20260706"
const rocToYmd = (s) => {
    const str = String(s || '').trim();
    if (str.length < 7) return '';
    const y = parseInt(str.slice(0, 3), 10) + 1911;
    return `${y}${str.slice(3, 5)}${str.slice(5, 7)}`;
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const list = [];
    let date = '';

    const [twseR, tpexR] = await Promise.allSettled([
        fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN', { headers: HEADERS }),
        fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance', { headers: HEADERS }),
    ]);

    // 上市（TWSE，中文欄位）
    if (twseR.status === 'fulfilled' && twseR.value.ok) {
        try {
            const arr = await twseR.value.json();
            for (const r of arr) {
                const code = String(r['股票代號'] || '').trim();
                if (!code) continue;
                list.push({
                    code,
                    name: String(r['股票名稱'] || '').trim(),
                    market: 'twse',
                    mPrev: toInt(r['融資前日餘額']),
                    mToday: toInt(r['融資今日餘額']),
                    sPrev: toInt(r['融券前日餘額']),
                    sToday: toInt(r['融券今日餘額']),
                    sRedeem: toInt(r['融券現券償還']),
                });
            }
        } catch { /* 忽略解析錯誤 */ }
    }

    // 上櫃（TPEx，英文欄位）
    if (tpexR.status === 'fulfilled' && tpexR.value.ok) {
        try {
            const arr = await tpexR.value.json();
            for (const r of arr) {
                const code = String(r.SecuritiesCompanyCode || '').trim();
                if (!code) continue;
                if (!date && r.Date) date = rocToYmd(r.Date);
                list.push({
                    code,
                    name: String(r.CompanyName || '').trim(),
                    market: 'tpex',
                    mPrev: toInt(r.MarginPurchaseBalancePreviousDay),
                    mToday: toInt(r.MarginPurchaseBalance),
                    sPrev: toInt(r.ShortSaleBalancePreviousDay),
                    sToday: toInt(r.ShortSaleBalance),
                    sRedeem: toInt(r.StockRedemption),
                });
            }
        } catch { /* 忽略解析錯誤 */ }
    }

    if (list.length === 0) {
        return res.status(502).json({ error: 'no margin data from TWSE/TPEx' });
    }

    // 融資融券每日盤後才更新一次，快取 30 分鐘
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ date, list });
}

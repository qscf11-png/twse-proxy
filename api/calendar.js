// Vercel Serverless Function — 台股交易日曆
// 路由: GET /api/calendar
// 回傳格式：{ dates: ["YYYY-MM-DD", ...] }（近兩個月，由舊到新）
//
// 為什麼要獨立一支：
// /api/history 需要一份「權威交易日曆」來判斷 Yahoo 的個股序列是否漏日。
// 原本拿 Yahoo 的加權指數 ^TWII 當日曆，但實測 Yahoo 連指數本身都會漏日
// （2026-09-03 在 ^TWII 與 0050 同時缺席），於是漏日偵測不到、補齊也就不會觸發。
// 改用證交所官方資料，並靠 Vercel 邊緣快取（s-maxage=3600）讓 36 檔並行請求
// 每小時只真正打證交所一次，避免上游限流。

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
};

// 以台積電當基準：上市至今每個交易日必有成交，缺日即代表非交易日
const REF_SYMBOL = '2330';

const rocToIso = (s) => {
    const m = String(s || '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
    return m ? `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}` : null;
};

export const getTradingDates = async (months = 2) => {
    const now = new Date();
    const jobs = [];
    for (let i = 0; i < months; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        jobs.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`);
    }

    const results = await Promise.all(jobs.map((ymd) =>
        fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd}&stockNo=${REF_SYMBOL}&response=json`,
            { headers: HEADERS })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
    ));

    const dates = new Set();
    for (const j of results) {
        if (j?.stat !== 'OK' || !Array.isArray(j.data)) continue;
        for (const row of j.data) {
            const d = rocToIso(row[0]);
            if (d) dates.add(d);
        }
    }
    return [...dates].sort();
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const dates = await getTradingDates(2);
        if (dates.length === 0) {
            // 不快取空結果，否則整整一小時的漏日偵測都會失效
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ dates: [] });
        }
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        return res.status(200).json({ dates });
    } catch (err) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ dates: [], error: err.message });
    }
}

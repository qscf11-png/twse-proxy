// Vercel Serverless Function — 集保 TDCC 股權分散表（近 N 週）
// 路由: GET /api/tdcc?stockNo=2330&weeks=5
// 對 TDCC qryStock 做 CSRF token 交握後查詢各週資料，解析 15 級分佈，
// 回傳散戶(<10張，級距1-3)與千張大戶(級距15)的每週人數/持股比例。
// 資料每週五更新一次，故快取 6 小時。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const QRY_URL = 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock';

const toInt = (s) => parseInt(String(s).replace(/,/g, ''), 10) || 0;

// 取得表單頁：回傳 cookie、token、firDate 與可查詢的週次日期清單
const fetchForm = async () => {
    const resp = await fetch(QRY_URL, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error('TDCC form fetch failed');
    const html = await resp.text();
    const cookies = [];
    // Node fetch: getSetCookie() 取得全部 Set-Cookie
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie')].filter(Boolean);
    for (const c of setCookies) cookies.push(String(c).split(';')[0]);
    const token = (html.match(/name="SYNCHRONIZER_TOKEN" value="([^"]+)"/) || [])[1];
    const firDate = (html.match(/name="firDate" value="([^"]+)"/) || [])[1] || '';
    const dates = [...html.matchAll(/<option value="(\d{8})"/g)].map(m => m[1]);
    if (!token || dates.length === 0) throw new Error('TDCC form parse failed');
    return { cookie: cookies.join('; '), token, firDate, dates };
};

// 查詢單一週次：獨立 session（GET 拿新 token → POST 查詢）
const fetchWeek = async (stockNo, scaDate) => {
    const form = await fetchForm();
    const body = new URLSearchParams({
        SYNCHRONIZER_TOKEN: form.token,
        SYNCHRONIZER_URI: '/portal/zh/smWeb/qryStock',
        method: 'submit',
        firDate: form.firDate,
        scaDate,
        sqlMethod: 'StockNo',
        stockNo,
        stockName: '',
    });
    const resp = await fetch(QRY_URL, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Referer': QRY_URL,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': form.cookie,
        },
        body: body.toString(),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // 解析 15 級 + 合計列：序號 | 級距 | 人數 | 股數 | 比例
    const levels = {};
    const re = /<td align="center">(\d{1,2})<\/td>\s*<td align="center">[^<]*<\/td>\s*<td align="right">([\d,]+)<\/td>\s*<td align="right">([\d,]+)<\/td>\s*<td align="right">([\d.]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        levels[parseInt(m[1], 10)] = {
            people: toInt(m[2]),
            shares: toInt(m[3]),
            pct: parseFloat(m[4]),
        };
    }
    if (!levels[15] && !levels[1]) return null; // 查無資料

    // 散戶 <10張 = 級距 1(1-999) + 2(1,000-5,000) + 3(5,001-10,000)
    const retail = [1, 2, 3].reduce((acc, lv) => {
        const d = levels[lv] || { people: 0, shares: 0, pct: 0 };
        return { people: acc.people + d.people, shares: acc.shares + d.shares, pct: acc.pct + d.pct };
    }, { people: 0, shares: 0, pct: 0 });
    // 千張大戶 = 級距 15(1,000,001 股以上)
    const big = levels[15] || { people: 0, shares: 0, pct: 0 };

    return {
        date: scaDate,
        retailPeople: retail.people,
        retailPct: parseFloat(retail.pct.toFixed(2)),
        bigPeople: big.people,
        bigPct: parseFloat(big.pct.toFixed(2)),
    };
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const stockNo = String(req.query.stockNo || '').trim();
    if (!/^[0-9A-Za-z]{4,6}$/.test(stockNo)) {
        return res.status(400).json({ error: 'invalid stockNo' });
    }
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 5, 1), 12);

    try {
        // 先拿一次表單取得可用週次清單，再平行查各週（各自獨立 session）
        const base = await fetchForm();
        const targetDates = base.dates.slice(0, weeks);
        const results = await Promise.all(targetDates.map(d => fetchWeek(stockNo, d).catch(() => null)));
        const series = results.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
        if (series.length === 0) {
            return res.status(200).json({ stockNo, weeks: [], note: 'no data (可能為興櫃以外或代號有誤)' });
        }
        // 週資料每週五更新，快取 6 小時
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
        return res.status(200).json({ stockNo, weeks: series });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

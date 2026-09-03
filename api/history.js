// Vercel Serverless Function — 個股歷史日 K 代理（Yahoo Finance）
// 路由: GET /api/history?symbol=2330&range=1y
// 於伺服器端抓 Yahoo Finance 日線（先試 .TW 再試 .TWO），回傳精簡的收盤序列。
// 回傳格式：{ symbol, history: [{ date: "YYYY-MM-DD", close: number }] }

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
};

const fetchYahoo = async (symbol, suffix, range) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${suffix}?interval=1d&range=${range}`;
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

// 民國日期（115/09/01）→ 西元（2026-09-01）
const rocToIso = (s) => {
    const m = String(s || '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
    return m ? `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}` : null;
};
const num = (s) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

/**
 * 以官方日成交資訊補齊 Yahoo 的缺漏日
 * 實測 Yahoo 會漏日（0050 缺 2026-09-01，該日大漲 +2.2，官方收 108.45），
 * 導致每日損益與均線失準。官方資料為權威，重疊日一律以官方為準。
 * 為控制延遲，只補最近 months 個月。
 */
const fetchOfficialRecent = async (symbol, months = 1) => {
    const out = {};
    const now = new Date();
    const jobs = [];
    for (let i = 0; i < months; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const y = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        jobs.push({ ymd: `${y}${mm}01`, slash: `${y}/${mm}/01` });
    }

    // 上市與上櫃同時查（不串行）：一檔只屬於其中一個市場，另一邊回空即可，
    // 如此每月僅耗一次 round-trip，避免上櫃股要等 TWSE 失敗後才查 TPEx。
    await Promise.all(jobs.map(async ({ ymd, slash }) => {
        const twse = fetch(
            `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd}&stockNo=${encodeURIComponent(symbol)}&response=json`,
            { headers: HEADERS }).then(r => (r.ok ? r.json() : null)).catch(() => null);
        const tpex = fetch(
            `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${encodeURIComponent(symbol)}&date=${encodeURIComponent(slash)}&response=json`,
            { headers: HEADERS }).then(r => (r.ok ? r.json() : null)).catch(() => null);
        const [jT, jP] = await Promise.all([twse, tpex]);

        // 上市（TWSE）：欄位 [日期,成交股數,成交金額,開,高,低,收,漲跌,筆數]
        if (jT?.stat === 'OK' && Array.isArray(jT.data)) {
            for (const row of jT.data) {
                const date = rocToIso(row[0]);
                const close = num(row[6]);
                if (!date || !(close > 0)) continue;
                out[date] = {
                    date, close,
                    high: num(row[4]) > 0 ? num(row[4]) : close,
                    low: num(row[5]) > 0 ? num(row[5]) : close,
                    volume: num(row[1]) || 0,
                };
            }
        }
        // 上櫃（TPEx）：欄位 [日期,成交張數,成交仟元,開,高,低,收,漲跌,筆數]
        for (const row of (jP?.tables?.[0]?.data || [])) {
            const date = rocToIso(row[0]);
            const close = num(row[6]);
            if (!date || !(close > 0) || out[date]) continue;   // 已有上市資料則不覆寫
            out[date] = {
                date, close,
                high: num(row[4]) > 0 ? num(row[4]) : close,
                low: num(row[5]) > 0 ? num(row[5]) : close,
                volume: (num(row[1]) || 0) * 1000,   // 張 → 股，與 Yahoo 單位一致
            };
        }
    }));

    return out;
};

/**
 * 交易日曆：以 Yahoo 的加權指數（^TWII）近一個月序列為準。
 * 用途是判斷個股序列是否真的缺日——只有缺日時才去打官方 API。
 * 若每檔都無條件補官方，36 檔併發時 TWSE/TPEx 會對同一出口 IP 限流，
 * 實測單檔延遲從 0.8s 飆到 10s 以上。
 */
const fetchCalendar = async () => {
    try {
        const h = await fetchYahoo('^TWII', '', '1mo');
        return h ? h.map((x) => x.date) : [];
    } catch {
        return [];
    }
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
    // 櫃買指數：Yahoo 的 ^TWOII 資料會停滯（實測停在 7/17 且數值失真），
    // 改以 TPEx 官方「日成交量值指數」逐月組出完整歷史。
    if (symbol === '^TWOII' || symbol === 'TWOII') {
        try {
            const months = { '1mo': 2, '3mo': 4, '6mo': 7, '1y': 13, '2y': 25, '5y': 61 }[req.query.range] || 7;
            const now = new Date();
            const seen = new Map();
            for (let i = months - 1; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const q = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/01`;
                const r = await fetch(
                    `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${encodeURIComponent(q)}&response=json`,
                    { headers: HEADERS });
                if (!r.ok) continue;
                const j = await r.json();
                for (const row of (j?.tables?.[0]?.data || [])) {
                    // 欄位：[民國日期, 成交股數, 成交金額, 成交筆數, 收盤指數, 漲跌]
                    const roc = String(row[0] || '').trim();
                    const m = roc.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
                    const close = parseFloat(String(row[4]).replace(/,/g, ''));
                    if (!m || !(close > 0)) continue;
                    const date = `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
                    const volume = parseInt(String(row[1]).replace(/,/g, ''), 10) || 0;
                    // 指數無 OHLC，以收盤價填充 high/low（型態判定改以收盤為準）
                    seen.set(date, { date, close, high: close, low: close, volume });
                }
            }
            const history = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
            if (history.length === 0) return res.status(200).json({ symbol, history: [] });
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
            return res.status(200).json({ symbol, history });
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }

    // 指數（^TWII 加權）不加 .TW/.TWO 後綴，直接查詢
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
        // 個股序列與交易日曆同時抓（日曆用於判斷是否缺日，不增加關鍵路徑延遲）
        const [histRaw, calendar] = await Promise.all([
            (async () => (await fetchYahoo(symbol, '.TW', range)) || (await fetchYahoo(symbol, '.TWO', range)))(),
            fetchCalendar(),
        ]);
        let history = histRaw;

        // 僅在近 20 個交易日確實有缺漏時，才以官方日成交補齊
        // （Yahoo 實測會漏日，如 0050 缺 2026-09-01，見 fetchOfficialRecent 註解）
        const have = new Set((history || []).map((h) => h.date));
        const firstDate = history?.[0]?.date;
        const gaps = calendar
            .slice(-20)
            .filter((d) => (!firstDate || d >= firstDate) && !have.has(d));

        if (gaps.length > 0) {
            const official = await fetchOfficialRecent(symbol, 1);
            if (Object.keys(official).length > 0) {
                const byDate = {};
                for (const h of (history || [])) byDate[h.date] = h;
                for (const [d, v] of Object.entries(official)) byDate[d] = v;   // 官方為準
                history = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
            }
        }

        if (!history || history.length === 0) {
            return res.status(200).json({ symbol, history: [] });
        }
        // 歷史日線每日僅更新一次，快取 1 小時
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({ symbol, history });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

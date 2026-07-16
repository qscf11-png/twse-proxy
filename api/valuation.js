// Vercel Serverless Function — 個股估值數據（上市＋上櫃合併）
// 路由: GET /api/valuation?codes=2330,5475（codes 可省略＝回傳全部）
// 合併四個官方 OpenAPI：
//   TWSE BWIBBU_ALL（上市 PE/PB/殖利率）、TPEx peratio_analysis（上櫃）
//   TWSE t187ap05_L（上市月營收）、TPEx mopsfin_t187ap05_O（上櫃月營收）
// 回傳 { date, list: [{code,name,market,pe,pb,yield,revMonth,revYoY,revAccYoY,revNote}] }

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
};

const toNum = (s) => {
    if (s == null || s === '' || s === '-') return null;
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const fetchJson = async (url) => {
    try {
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // 選擇性過濾代號清單
    const codesParam = String(req.query.codes || '').trim();
    const filter = codesParam
        ? new Set(codesParam.split(',').map(s => s.trim()).filter(Boolean))
        : null;

    const [twsePe, tpexPe, twseRev, tpexRev] = await Promise.all([
        fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL'),
        fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis'),
        fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap05_L'),
        fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'),
    ]);

    const map = {};
    let date = '';

    // 上市 PE/PB/殖利率
    for (const r of (Array.isArray(twsePe) ? twsePe : [])) {
        const code = String(r.Code || '').trim();
        if (!code || (filter && !filter.has(code))) continue;
        if (!date && r.Date) date = r.Date;
        map[code] = {
            code, name: String(r.Name || '').trim(), market: 'twse',
            pe: toNum(r.PEratio), pb: toNum(r.PBratio), yield: toNum(r.DividendYield),
        };
    }
    // 上櫃 PE/PB/殖利率
    for (const r of (Array.isArray(tpexPe) ? tpexPe : [])) {
        const code = String(r.SecuritiesCompanyCode || '').trim();
        if (!code || (filter && !filter.has(code))) continue;
        map[code] = {
            code, name: String(r.CompanyName || '').trim(), market: 'tpex',
            pe: toNum(r.PriceEarningRatio), pb: toNum(r.PriceBookRatio), yield: toNum(r.YieldRatio),
        };
    }
    // 月營收（上市＋上櫃欄位相同）
    for (const arr of [twseRev, tpexRev]) {
        for (const r of (Array.isArray(arr) ? arr : [])) {
            const code = String(r['公司代號'] || '').trim();
            if (!code || (filter && !filter.has(code)) || !map[code]) continue;
            map[code].revMonth = String(r['資料年月'] || '');
            map[code].revYoY = toNum(r['營業收入-去年同月增減(%)']);
            map[code].revAccYoY = toNum(r['累計營業收入-前期比較增減(%)']);
            map[code].industry = String(r['產業別'] || '');
            const note = String(r['備註'] || '').trim();
            if (note && note !== '-') map[code].revNote = note.slice(0, 60);
        }
    }

    const list = Object.values(map);
    if (list.length === 0) {
        return res.status(502).json({ error: 'no valuation data' });
    }
    // 估值數據每日更新，快取 6 小時
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json({ date, list });
}

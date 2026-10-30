/* ============================================================
   PRYME ANALYSER — backend
   - Market data proxy: Crypto (Binance), Forex/Gold/Indices/Intl stocks (Yahoo),
     Sri Lanka CSE (cse.lk public JSON API)
   - Daily news (Google News RSS)
   - AI proxy for free LLM keys (Groq, Gemini, OpenRouter, Mistral, Cerebras)
   Keys are NEVER stored on the server — they come from the user's browser per request.
   ============================================================ */
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// TradingView Advanced Charts library (optional) lives in public/charting_library — if it's not there, answer 404 (not index.html)
app.use('/charting_library', (_, res) => res.status(404).end());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

/* ---------- tiny cache ---------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...(opts.headers || {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/* ---------- helpers ---------- */
function aggregate(candles, sec) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== b) {
      if (cur) out.push(cur);
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------- CRYPTO (Binance public market data) ---------- */
function normCrypto(s) {
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/(USDT|USDC|BTC|ETH|FDUSD|BUSD)$/.test(s)) s += 'USDT';
  return s;
}
// Multi-source crypto candles: Binance → Bybit → OKX. If one blocks/rate-limits the server, the next is used.
const BYBIT_TF = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const OKX_TF = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };
const srcBlock = {}; // source -> blocked until (ms)
function noteSrcError(src, e) {
  const m = /HTTP (403|418|429|451)/.exec(e.message || ''); if (!m) return;
  const until = /banned until (\d{13})/.exec(e.message);
  const mins = { '403': 30, '418': 30, '429': 2, '451': 360 }[m[1]];
  srcBlock[src] = until ? +until[1] : Date.now() + mins * 60 * 1000;
}
const okxInst = s => { const m = /^(.+?)(USDT|USDC|BTC|ETH)$/.exec(s); return m ? `${m[1]}-${m[2]}` : s; };
const CRYPTO_SOURCES = {
  binance: async (s, tf, limit) => {
    let lastErr;
    for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      try {
        const rows = await fetchJSON(`${h}/api/v3/klines?symbol=${s}&interval=${tf}&limit=${Math.min(limit, 1000)}`);
        return rows.map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
      } catch (e) { lastErr = e; noteSrcError('binance', e); if (Date.now() < (srcBlock.binance || 0)) break; }
    }
    throw lastErr;
  },
  bybit: async (s, tf, limit) => {
    const j = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}&interval=${BYBIT_TF[tf]}&limit=${Math.min(limit, 1000)}`);
    const list = j?.result?.list;
    if (!Array.isArray(list) || !list.length) throw new Error('bybit: ' + (j.retMsg || 'no data'));
    return list.map(r => ({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
  },
  okx: async (s, tf, limit) => {
    const inst = okxInst(s);
    let rows = (await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${OKX_TF[tf]}&limit=300`)).data || [];
    // page older history if more is needed
    while (rows.length && rows.length < limit) {
      const older = (await fetchJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${OKX_TF[tf]}&after=${rows[rows.length - 1][0]}&limit=100`)).data || [];
      if (!older.length) break; rows = rows.concat(older);
    }
    if (!rows.length) throw new Error('okx: no data for ' + inst);
    return rows.map(r => ({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
  }
};
async function cryptoCandles(symbol, tf, limit) {
  const s = normCrypto(symbol);
  const errs = [];
  for (const [src, fn] of Object.entries(CRYPTO_SOURCES)) {
    if (Date.now() < (srcBlock[src] || 0)) { errs.push(`${src} paused`); continue; }
    try {
      const candles = (await fn(s, tf, limit)).slice(-limit);
      if (candles.length) return { symbol: s, tv: 'BINANCE:' + s, feed: src, candles };
    } catch (e) { noteSrcError(src, e); errs.push(`${src}: ${String(e.message).slice(0, 80)}`); }
  }
  throw new Error('All crypto feeds failed (' + errs.join(' | ') + ')');
}

/* ---------- FOREX / GOLD / INDICES / INTL STOCKS (Yahoo Finance chart API) ---------- */
const FX_MAP = {
  XAUUSD: 'GC=F', GOLD: 'GC=F', XAGUSD: 'SI=F', SILVER: 'SI=F', USOIL: 'CL=F', WTI: 'CL=F', UKOIL: 'BZ=F',
  US30: '^DJI', DJI: '^DJI', NAS100: '^NDX', NDX: '^NDX', US100: '^NDX', SPX500: '^GSPC', US500: '^GSPC',
  GER40: '^GDAXI', UK100: '^FTSE', JP225: '^N225', DXY: 'DX-Y.NYB'
};
function normYahoo(symbol, market) {
  let s = symbol.toUpperCase().trim().replace(/\s+/g, '');
  if (FX_MAP[s]) return FX_MAP[s];
  if (market === 'forex') {
    s = s.replace('/', '');
    if (/^[A-Z]{6}$/.test(s)) return s + '=X';
  }
  return s;
}
const YH = {
  '1m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '30m': ['30m', '1mo'],
  '1h': ['60m', '6mo'], '4h': ['60m', '2y'], '1d': ['1d', '5y']
};
/* Spot metals: Yahoo only has futures (GC=F / SI=F) which trade $10-20 above spot.
   We fetch the live SPOT price and shift the futures candles so prices match
   OANDA:XAUUSD on TradingView and your broker. */
const METAL = { 'GC=F': { code: 'XAU', tv: 'OANDA:XAUUSD', tvFut: 'COMEX:GC1!' }, 'SI=F': { code: 'XAG', tv: 'OANDA:XAGUSD', tvFut: 'COMEX:SI1!' } };
const lastBasis = {};
async function metalSpot(code) {
  return cached('spot|' + code, 8000, async () => {
    try {
      const j = await fetchJSON(`https://api.gold-api.com/price/${code}`, {}, 6000);
      if (+j.price > 0) return +j.price;
    } catch (_) { }
    if (code === 'XAU') { // fallback: PAX Gold on Binance (1 PAXG = 1 oz gold)
      const hosts = ['https://data-api.binance.vision', 'https://api.binance.com'];
      for (const h of hosts) {
        try { const j = await fetchJSON(`${h}/api/v3/ticker/price?symbol=PAXGUSDT`, {}, 6000); if (+j.price > 0) return +j.price; } catch (_) { }
      }
    }
    return null;
  });
}
const TV_INDEX = { '^NDX': 'NASDAQ:NDX', '^DJI': 'DJ:DJI', '^GSPC': 'SP:SPX', '^GDAXI': 'XETR:DAX', '^FTSE': 'TVC:UKX', '^N225': 'TVC:NI225', 'DX-Y.NYB': 'TVC:DXY', 'CL=F': 'NYMEX:CL1!', 'BZ=F': 'ICEEUR:BRN1!' };
const TV_SUFFIX = { NS: 'NSE', BO: 'BSE', L: 'LSE', TO: 'TSX', V: 'TSXV', AX: 'ASX', HK: 'HKEX', T: 'TSE', DE: 'XETR', F: 'FWB', PA: 'EURONEXT', AS: 'EURONEXT', BR: 'EURONEXT', MI: 'MIL', MC: 'BME', SW: 'SIX', ST: 'OMXSTO', CO: 'OMXCOP', OL: 'OSL', KS: 'KRX', KQ: 'KRX', SS: 'SSE', SZ: 'SZSE', SI: 'SGX', JK: 'IDX', KL: 'MYX', BK: 'SET', SA: 'BMFBOVESPA', MX: 'BMV', JO: 'JSE', TW: 'TWSE', NZ: 'NZX', IS: 'BIST', TA: 'TASE', SR: 'TADAWUL', QA: 'QSE', AE: 'DFM' };
function tvForYahoo(ys) {
  if (TV_INDEX[ys]) return TV_INDEX[ys];
  if (ys.endsWith('=X')) return 'FX_IDC:' + ys.replace('=X', '');
  const m = /^(.+)\.([A-Z]{1,3})$/.exec(ys);
  if (m && TV_SUFFIX[m[2]]) return TV_SUFFIX[m[2]] + ':' + m[1].replace(/-/g, '_');
  return ys.replace(/-/g, '.');
}

/* GOLD: real-time candles from Binance PAXG (1 PAXG = 1 oz gold, no 10-min delay like COMEX on Yahoo),
   shifted to the live spot price so levels match OANDA:XAUUSD / your broker. */
/* Live spot gold ticks (every 5s while someone is watching) → accurate 1m candles with real wicks */
const goldTicks = []; let goldTimer = null, goldWant = 0;
function wantGoldTicks() {
  goldWant = Date.now();
  if (goldTimer) return;
  const tick = async () => {
    if (Date.now() - goldWant > 10 * 60 * 1000) { clearInterval(goldTimer); goldTimer = null; return; }
    try {
      const j = await fetchJSON('https://api.gold-api.com/price/XAU', {}, 4500);
      if (+j.price > 0) { goldTicks.push({ t: Math.floor(Date.now() / 1000), p: +j.price }); if (goldTicks.length > 30000) goldTicks.splice(0, 10000); }
    } catch (_) { }
  };
  tick(); goldTimer = setInterval(tick, 5000);
}
function goldTickCandles() {
  return aggregate(goldTicks.map(x => ({ time: x.t, open: x.p, high: x.p, low: x.p, close: x.p, volume: 0 })), 60);
}
async function goldSpotCandles(tf, limit) {
  wantGoldTicks();
  const k = await cryptoCandles('PAXGUSDT', tf, limit);
  if (!k.candles.length) throw new Error('no PAXG data');
  const last = k.candles[k.candles.length - 1].close;
  let spot = null;
  const lt = goldTicks[goldTicks.length - 1];
  if (lt && Date.now() / 1000 - lt.t < 20) spot = lt.p;
  else { try { const j = await cached('goldapi', 8000, () => fetchJSON('https://api.gold-api.com/price/XAU', {}, 6000)); spot = +j.price || null; } catch (_) { } }
  if (spot && Math.abs(spot - last) / last < 0.03) lastBasis.PAXG = { b: spot - last, t: Date.now() };
  const lb = lastBasis.PAXG, b = lb && Date.now() - lb.t < 60 * 60 * 1000 ? lb.b : 0;
  let candles = k.candles.map(c => ({ ...c, open: c.open + b, high: c.high + b, low: c.low + b, close: c.close + b }));
  let feed = (b ? 'PAXG + spot adjust' : 'PAXG (spot feed down)') + ' · ' + k.feed;
  if (tf === '1m') {
    // replace with true spot candles where we have ticks (skip the first, partial minute)
    const tc = goldTickCandles().slice(1);
    if (tc.length) {
      const from = tc[0].time;
      candles = candles.filter(c => c.time < from).concat(tc).slice(-limit);
      feed = 'live spot ticks';
    }
  }
  return { symbol: 'XAUUSD', tv: 'OANDA:XAUUSD', currency: 'USD', name: 'Gold spot (XAU/USD)', priceNote: 'spot', feed, candles };
}

async function yahooCandles(symbol, market, tf, limit) {
  const ys = normYahoo(symbol, market);
  if (ys === 'GC=F') { try { return await goldSpotCandles(tf, limit); } catch (_) { /* fall back to Yahoo below */ } }
  const [interval, range] = YH[tf] || YH['1h'];
  let data, lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      data = await fetchJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?interval=${interval}&range=${range}&includePrePost=false`);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr;
  const res = data?.chart?.result?.[0];
  if (!res || !res.timestamp) throw new Error('No data for symbol ' + ys);
  const q = res.indicators.quote[0];
  let candles = [];
  res.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  });
  if (tf === '4h') candles = aggregate(candles, 14400);
  let tv = tvForYahoo(ys), name = res.meta?.longName || res.meta?.shortName, priceNote = null;
  const metal = METAL[ys];
  if (metal && candles.length) {
    const spot = await metalSpot(metal.code);
    const last = candles[candles.length - 1].close;
    if (spot && Math.abs(spot - last) / last < 0.03) lastBasis[ys] = { b: spot - last, t: Date.now() };
    const lb = lastBasis[ys];
    if (lb && Date.now() - lb.t < 30 * 60 * 1000) {
      const b = lb.b;
      candles = candles.map(c => ({ ...c, open: c.open + b, high: c.high + b, low: c.low + b, close: c.close + b }));
      tv = metal.tv; name = metal.code === 'XAU' ? 'Gold spot (XAU/USD)' : 'Silver spot (XAG/USD)';
      priceNote = 'spot';
    } else {
      tv = metal.tvFut; priceNote = 'futures (spot feed unavailable)';
    }
  }
  return { symbol: ys, tv, currency: res.meta?.currency, name, priceNote, candles: candles.slice(-limit) };
}

/* ---------- SRI LANKA CSE (unofficial public JSON API on cse.lk) ---------- */
const cseTicks = new Map(); // symbol -> [{time, price, vol}] built while server runs
function normCSE(s) {
  s = s.toUpperCase().trim();
  if (!s.includes('.')) s += '.N0000';
  return s;
}
async function csePost(endpoint, body) {
  return fetchJSON(`https://www.cse.lk/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.cse.lk', Referer: 'https://www.cse.lk/' },
    body
  });
}
function pickNum(o, keys) { for (const k of keys) if (o[k] != null && !isNaN(+o[k])) return +o[k]; return null; }

async function cseCandles(symbol, tf, limit) {
  const s = normCSE(symbol);
  // symbol only in the URL (sending it in the body too makes CSE read "JKH.N0000,JKH.N0000" → 404)
  let info;
  try { info = await csePost(`companyInfoSummery?symbol=${encodeURIComponent(s)}`, ''); }
  catch (e) { info = await csePost('companyInfoSummery', `symbol=${encodeURIComponent(s)}`); }
  if (!info?.reqSymbolInfo?.symbol && !info?.reqSymbolInfo?.lastTradedPrice) throw new Error(`CSE: no data for ${s} — check the symbol (e.g. JKH.N0000)`);
  const ri = info?.reqSymbolInfo || {};
  const id = ri.id || ri.securityId;
  const quote = {
    name: ri.name, last: +ri.lastTradedPrice || null, prevClose: +ri.previousClose || null,
    change: ri.change, changePct: ri.changePercentage,
    dayHigh: +ri.hiTrade || null, dayLow: +ri.lowTrade || null,
    wk52High: +(info?.reqSymbolBetaInfo?.wk52High || ri.p12HiPrice || 0) || null,
    wk52Low: +(info?.reqSymbolBetaInfo?.wk52Low || ri.p12LowPrice || 0) || null,
    marketCap: ri.marketCap
  };

  // record a tick so intraday candles build up over time even if chart endpoint fails
  if (quote.last) {
    const arr = cseTicks.get(s) || [];
    arr.push({ time: Math.floor(Date.now() / 1000), price: quote.last });
    if (arr.length > 20000) arr.shift();
    cseTicks.set(s, arr);
  }

  let candles = [];
  // Try chart endpoints (period: 1=1D, 2=1W, 3=1M, 4=3M/6M, 5=1Y). Response shape varies, parse defensively.
  const periods = tf === '1d' ? [5, 4, 3] : (tf === '4h' || tf === '1h') ? [3, 2, 1] : [1, 2];
  for (const p of periods) {
    if (!id) break;
    try {
      const d = await csePost('companyChartDataByStock', `stockId=${id}&period=${p}`);
      const rows = d?.chartData || d?.reqChartData || (Array.isArray(d) ? d : []);
      const pts = rows.map(r => {
        let t = r.t ?? r.time ?? r.tradeDate ?? r.date ?? r.d;
        if (typeof t === 'string') t = Date.parse(t);
        if (t > 1e12) t = Math.floor(t / 1000);
        const c = pickNum(r, ['c', 'close', 'p', 'price', 'closingPrice', 'lastTradedPrice']);
        if (!t || c == null) return null;
        return {
          time: t,
          open: pickNum(r, ['o', 'open', 'openingPrice']) ?? c,
          high: pickNum(r, ['h', 'high', 'highPrice']) ?? c,
          low: pickNum(r, ['l', 'low', 'lowPrice']) ?? c,
          close: c,
          volume: pickNum(r, ['q', 'v', 'volume', 'qty', 'shareVolume']) || 0
        };
      }).filter(Boolean).sort((a, b) => a.time - b.time);
      if (pts.length > 10) { candles = pts; break; }
    } catch (_) { /* try next */ }
  }
  if (candles.length) {
    candles = aggregate(candles, TF_SEC[tf] || 3600);
  } else {
    // fallback: candles from ticks collected by this server
    const ticks = (cseTicks.get(s) || []).map(t => ({ time: t.time, open: t.price, high: t.price, low: t.price, close: t.price }));
    candles = aggregate(ticks, TF_SEC[tf] || 3600);
  }
  return { symbol: s, tv: 'CSELK:' + s, currency: 'LKR', name: quote.name, quote, candles: candles.slice(-limit), limited: candles.length < 30 };
}

/* ---------- routes ---------- */
app.get('/api/health', (_, res) => res.json({ ok: true, time: Date.now() }));

// Live spot gold for the browser (it fetches PAXG candles from Binance itself and shifts them to spot)
app.get('/api/goldspot', async (req, res) => {
  wantGoldTicks();
  let spot = null;
  const lt = goldTicks[goldTicks.length - 1];
  if (lt && Date.now() / 1000 - lt.t < 20) spot = lt.p;
  else { try { const j = await cached('goldapi', 8000, () => fetchJSON('https://api.gold-api.com/price/XAU', {}, 6000)); spot = +j.price || null; } catch (_) { } }
  res.json({ spot, candles1m: req.query.m1 ? goldTickCandles().slice(1) : [] });
});

// Open https://<your-app>.onrender.com/api/diag to see which data feeds work from the server
app.get('/api/diag', async (_, res) => {
  const test = async (name, fn) => { const t = Date.now(); try { const v = await fn(); return { name, ok: true, ms: Date.now() - t, sample: v }; } catch (e) { return { name, ok: false, ms: Date.now() - t, error: e.message }; } };
  const out = await Promise.all([
    test('Binance', async () => (await CRYPTO_SOURCES.binance('BTCUSDT', '1m', 2)).at(-1).close),
    test('Bybit', async () => (await CRYPTO_SOURCES.bybit('BTCUSDT', '1m', 2)).at(-1).close),
    test('OKX', async () => (await CRYPTO_SOURCES.okx('BTCUSDT', '1m', 2)).at(-1).close),
    test('Gold spot (gold-api.com)', async () => (await fetchJSON('https://api.gold-api.com/price/XAU', {}, 6000)).price),
    test('Yahoo (forex + stocks)', async () => { const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1m&range=1d'); return d.chart.result[0].meta.regularMarketPrice; }),
    test('CSE (cse.lk)', async () => (await csePost('marketStatus', '')).status),
  ]);
  res.json({ region: process.env.RENDER_REGION || 'unknown', goldTicks: goldTicks.length, paused: Object.fromEntries(Object.entries(srcBlock).filter(([, v]) => v > Date.now()).map(([k, v]) => [k, new Date(v).toISOString()])), feeds: out });
});

app.get('/api/candles', async (req, res) => {
  const market = (req.query.market || 'crypto').toLowerCase();
  const symbol = (req.query.symbol || 'BTCUSDT').trim();
  const tf = TF_SEC[req.query.tf] ? req.query.tf : '1h';
  const limit = Math.min(+req.query.limit || 500, 1000);
  // round the limit up so many different requests share one cached upstream call
  const fetchLimit = limit <= 100 ? 100 : limit <= 500 ? 500 : 1000;
  try {
    const ttl = tf === '1m' ? 8000 : 20000;
    const out = await cached(`${market}|${symbol.toUpperCase()}|${tf}|${fetchLimit}`, ttl, async () => {
      if (market === 'crypto') return cryptoCandles(symbol, tf, fetchLimit);
      if (market === 'cse') return cseCandles(symbol, tf, fetchLimit);
      return yahooCandles(symbol, market, tf, fetchLimit);
    });
    res.json({ market, tf, ...out, candles: (out.candles || []).slice(-limit) });
  } catch (e) {
    res.status(502).json({ error: 'Data fetch failed: ' + e.message });
  }
});

/* ---------- SYMBOL SEARCH (any stock / coin / forex pair / CSE company) ---------- */
const CCY = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'BRL', 'CNH', 'CNY', 'INR', 'LKR', 'PKR', 'THB', 'MYR', 'IDR', 'PHP', 'KRW', 'TWD', 'AED', 'SAR', 'QAR', 'KWD', 'ILS', 'RUB', 'CLP', 'COP', 'EGP', 'NGN', 'KES', 'BDT', 'VND'];
const MAJ = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'];
const FX_EXTRA = [['XAUUSD', 'Gold spot'], ['XAGUSD', 'Silver spot'], ['USOIL', 'WTI crude oil'], ['UKOIL', 'Brent crude oil'], ['NAS100', 'Nasdaq 100'], ['US30', 'Dow Jones 30'], ['SPX500', 'S&P 500'], ['GER40', 'DAX 40'], ['UK100', 'FTSE 100'], ['JP225', 'Nikkei 225'], ['DXY', 'US dollar index']];
function fxUniverse() {
  const set = new Map(FX_EXTRA.map(([s, n]) => [s, n]));
  for (const a of MAJ) for (const b of MAJ) if (a !== b) set.set(a + b, `${a}/${b}`);
  for (const c of CCY) if (!MAJ.includes(c)) { set.set('USD' + c, `USD/${c}`); set.set('EUR' + c, `EUR/${c}`); set.set('GBP' + c, `GBP/${c}`); }
  return [...set].map(([symbol, name]) => ({ symbol, name }));
}
let cryptoListFailAt = 0;
async function cryptoUniverse() {
  if (Date.now() - cryptoListFailAt < 5 * 60 * 1000 && !cache.get('cryptoList')) return [];
  try {
    return await cached('cryptoList', 6 * 3600 * 1000, async () => {
      // Bybit first (cheap); Binance's full ticker list is "heavy" and can get a shared IP banned
      try {
        const j = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=spot', {}, 20000);
        const list = (j?.result?.list || []).filter(r => /USDT$/.test(r.symbol) && +r.turnover24h > 0)
          .sort((a, b) => +b.turnover24h - +a.turnover24h).map(r => ({ symbol: r.symbol, name: r.symbol.replace(/USDT$/, '') + ' / Tether' }));
        if (list.length) return list;
      } catch (_) { }
      const j = await fetchJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT', {}, 20000);
      const list = (j.data || []).filter(r => /-USDT$/.test(r.instId)).sort((a, b) => +b.volCcy24h * +b.last - +a.volCcy24h * +a.last)
        .map(r => ({ symbol: r.instId.replace('-', ''), name: r.instId.replace('-USDT', '') + ' / Tether' }));
      if (!list.length) throw new Error('no list');
      return list;
    });
  } catch (_) { cryptoListFailAt = Date.now(); return []; }
}
async function cseUniverse() {
  return cached('cseList', 6 * 3600 * 1000, async () => {
    const rows = await csePost('allSecurityCode', '');
    return (Array.isArray(rows) ? rows : []).filter(r => r.active !== 0).map(r => ({ symbol: r.symbol, name: r.name }));
  });
}
app.get('/api/search', async (req, res) => {
  const market = (req.query.market || 'stock').toLowerCase();
  const q = String(req.query.q || '').trim().toUpperCase();
  try {
    let out = [];
    if (market === 'forex') {
      const qq = q.replace(/[^A-Z0-9]/g, '');
      out = fxUniverse().filter(x => !qq || x.symbol.includes(qq) || x.name.toUpperCase().includes(q));
    } else if (market === 'crypto') {
      const qq = q.replace(/[^A-Z0-9]/g, '');
      const all = await cryptoUniverse();
      out = qq ? all.filter(x => x.symbol.startsWith(qq)).concat(all.filter(x => !x.symbol.startsWith(qq) && x.symbol.includes(qq))) : all;
    } else if (market === 'cse') {
      const all = await cseUniverse();
      out = all.filter(x => !q || x.symbol.includes(q) || (x.name || '').toUpperCase().includes(q));
    } else {
      if (!q) return res.json({ items: [] });
      const j = await cached('ysearch|' + q, 3600 * 1000, () => fetchJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0`));
      out = (j.quotes || []).filter(x => ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(x.quoteType))
        .map(x => ({ symbol: x.symbol, name: `${x.shortname || x.longname || ''} · ${x.exchDisp || x.exchange || ''}` }));
    }
    res.json({ items: out.slice(0, 30) });
  } catch (e) {
    res.json({ items: [], error: e.message });
  }
});

/* ---------- NEWS (Google News RSS, free) ---------- */
const CUR_NAMES = { USD: 'US dollar Fed', EUR: 'euro ECB', GBP: 'pound Bank of England', JPY: 'yen Bank of Japan', AUD: 'Australian dollar RBA', CAD: 'Canadian dollar', CHF: 'Swiss franc', NZD: 'New Zealand dollar', XAU: 'gold price', XAG: 'silver price' };
function newsQuery(market, symbol, name) {
  const s = symbol.toUpperCase();
  if (market === 'forex') {
    const a = s.slice(0, 3), b = s.slice(3, 6);
    const parts = [CUR_NAMES[a] || a, CUR_NAMES[b] || b].join(' OR ');
    return `${parts} forex`;
  }
  if (market === 'crypto') {
    const coin = s.replace(/(USDT|USDC|FDUSD|BUSD)$/, '');
    const names = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP Ripple', BNB: 'BNB', DOGE: 'Dogecoin', ADA: 'Cardano' };
    return `${names[coin] || coin} crypto`;
  }
  if (market === 'cse') return `${name || s.split('.')[0]} Colombo Stock Exchange`;
  return `${name || s} stock`;
}
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  const tag = (block, t) => {
    const r = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`).exec(block);
    return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
  };
  while ((m = re.exec(xml)) && items.length < 15) {
    items.push({ title: tag(m[1], 'title'), link: tag(m[1], 'link'), date: tag(m[1], 'pubDate'), source: tag(m[1], 'source') });
  }
  return items;
}
app.get('/api/news', async (req, res) => {
  const market = (req.query.market || 'crypto').toLowerCase();
  const symbol = req.query.symbol || 'BTCUSDT';
  const q = newsQuery(market, symbol, req.query.name);
  try {
    const items = await cached('news|' + q, 10 * 60 * 1000, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const geo = market === 'cse' ? 'hl=en-LK&gl=LK&ceid=LK:en' : 'hl=en-US&gl=US&ceid=US:en';
        const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&${geo}`, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        return parseRSS(await r.text());
      } finally { clearTimeout(timer); }
    });
    res.json({ query: q, items });
  } catch (e) {
    res.json({ query: q, items: [], error: e.message });
  }
});

/* ---------- AI PROXY ---------- */
const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama-3.3-70b' },
  gemini: { model: 'gemini-2.5-flash' }
};

async function callAI({ provider, key, model, system, prompt }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Unknown provider ' + provider);
  const m = (model || '').trim() || p.model;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    if (provider === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.25, responseMimeType: 'application/json', maxOutputTokens: 4096 }
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `Gemini HTTP ${r.status}`);
      return { text: j?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '', model: m };
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://pryme-analyser.onrender.com'; headers['X-Title'] = 'Pryme Analyser'; }
    const body = { model: m, temperature: 0.25, max_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
    if (provider !== 'openrouter') body.response_format = { type: 'json_object' };
    const r = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || j?.message || `${provider} HTTP ${r.status}`);
    return { text: j?.choices?.[0]?.message?.content || '', model: m };
  } finally { clearTimeout(timer); }
}

// Tries each enabled key in order until one works (auto failover).
app.post('/api/ai', async (req, res) => {
  const { keys = [], system, prompt } = req.body || {};
  const errors = [];
  for (const k of keys) {
    if (!k || !k.key || !k.provider) continue;
    try {
      const out = await callAI({ provider: k.provider, key: k.key, model: k.model, system, prompt });
      if (out.text) return res.json({ provider: k.provider, model: out.model, text: out.text, errors });
      errors.push(`${k.provider}: empty response`);
    } catch (e) {
      errors.push(`${k.provider}: ${e.message}`);
    }
  }
  res.status(502).json({ error: 'All AI keys failed', errors });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pryme Analyser running on http://localhost:${PORT}`));

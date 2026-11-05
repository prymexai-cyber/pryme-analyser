/* ============================================================
   PRYME QUANT — backend
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
// service worker must never be cached by the browser, so app updates arrive straight away
app.get('/sw.js', (_, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'sw.js')); });
// Android app (PWABuilder / Trusted Web Activity): proves the app and this site belong together → full screen, no browser bar.
// Paste the JSON PWABuilder gives you into the ASSETLINKS_JSON env var on Render (or save it as assetlinks.json next to server.js).
app.get('/.well-known/assetlinks.json', (_, res) => {
  try {
    const txt = process.env.ASSETLINKS_JSON || require('fs').readFileSync(path.join(__dirname, 'assetlinks.json'), 'utf8');
    res.type('application/json').send(txt);
  } catch { res.status(404).json([]); }
});
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
/* Time-zone helpers so candles open at the same moment as on TradingView:
   forex 17:00 New York, gold/oil/futures 18:00 New York, stocks at the exchange open (e.g. 9:30 NY). */
const tzFmt = {}, tzOffCache = new Map();
function tzOffset(t, tz) { // seconds east of UTC for this zone at unix time t (handles daylight saving)
  const k = tz + '|' + Math.floor(t / 1800);
  if (tzOffCache.has(k)) return tzOffCache.get(k);
  const f = tzFmt[tz] || (tzFmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  const off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) / 1000 - t) / 60) * 60;
  if (tzOffCache.size > 20000) tzOffCache.clear();
  tzOffCache.set(k, off); return off;
}
function sessionStart(t, a) { // most recent session open (a = {tz, h, m}) at or before t
  const off = tzOffset(t, a.tz), local = t + off;
  let s = Math.floor(local / 86400) * 86400 + a.h * 3600 + (a.m || 0) * 60;
  if (s > local) s -= 86400;
  return s - off;
}
function bucketOf(t, sec, a) {
  if (!a) return Math.floor(t / sec) * sec;
  const ss = sessionStart(t, a);
  if (sec >= 86400) return a.h >= 12 ? Math.floor((ss + 86400) / 86400) * 86400 : Math.floor((ss + tzOffset(ss, a.tz)) / 86400) * 86400; // daily bar labelled with its trading date
  return ss + Math.floor((t - ss) / sec) * sec;
}
function aggregate(candles, sec, anchor) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = bucketOf(c.time, sec, anchor);
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
  if (ys.endsWith('=X')) { const p = ys.replace('=X', ''); return (FX_OANDA.has(p.slice(0, 3)) && FX_OANDA.has(p.slice(3)) ? 'OANDA:' : 'FX_IDC:') + p; }
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
/* Session anchor per instrument, so 4H / 1D candles open at the same time as on TradingView */
const NY = 'America/New_York';
const FX_OANDA = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'CNH', 'THB']);
function anchorFor(ys, meta) {
  if (ys.endsWith('=X')) return { tz: NY, h: 17, m: 0 };            // forex day starts 17:00 New York
  if (ys.endsWith('=F') || ys === 'DX-Y.NYB') return { tz: NY, h: 18, m: 0 }; // metals / oil / futures: 18:00 New York
  const tz = meta?.exchangeTimezoneName, st = meta?.currentTradingPeriod?.regular?.start;
  if (tz && st) { const off = tzOffset(st, tz), l = (st + off) % 86400; return { tz, h: Math.floor(l / 3600), m: Math.floor(l % 3600 / 60) }; }
  return null;
}
async function yahooRaw(ys, interval, range) {
  return cached(`yraw|${ys}|${interval}|${range}`, interval === '1m' ? 8000 : 20000, async () => {
    let data, lastErr;
    for (const host of ['query1', 'query2']) {
      try { data = await fetchJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?interval=${interval}&range=${range}&includePrePost=false`); break; }
      catch (e) { lastErr = e; }
    }
    if (!data) throw lastErr;
    const res = data?.chart?.result?.[0];
    if (!res || !res.timestamp) throw new Error('No data for symbol ' + ys);
    const q = res.indicators.quote[0], candles = [];
    res.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
      candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
    });
    return { meta: res.meta || {}, candles };
  });
}
// which Yahoo request builds each timeframe (4H and, for 24h markets, 1D are built from 1H so they open at the right hour)
function yahooPlan(tf, anchor24h) {
  if (tf === '4h') return ['60m', '2y', 14400];
  if (tf === '1d' && anchor24h) return ['60m', '2y', 86400];
  const [interval, range] = YH[tf] || YH['1h'];
  return [interval, range, 0];
}
async function yahooSeries(ys, tf) {
  const pre = ys.endsWith('=X') || ys.endsWith('=F') || ys === 'DX-Y.NYB';
  const [interval, range, agg] = yahooPlan(tf, pre);
  const r = await yahooRaw(ys, interval, range);
  const anchor = anchorFor(ys, r.meta);
  let candles = r.candles.slice();
  // drop Yahoo's extra "live" row that duplicates the last bar
  if (candles.length > 1 && candles[candles.length - 1].time - candles[candles.length - 2].time < ({ '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '60m': 3600, '1d': 86400 }[interval] || 60)) {
    const l = candles.pop(), p = candles[candles.length - 1];
    candles[candles.length - 1] = { ...p, high: Math.max(p.high, l.high), low: Math.min(p.low, l.low), close: l.close };
  }
  if (agg) candles = aggregate(candles, agg, anchor);
  return { meta: r.meta, anchor, candles };
}

/* GOLD (XAUUSD) — shaped like OANDA:XAUUSD on TradingView:
   history = COMEX gold (same trading hours as spot, closed at weekends, same 18:00 NY session)
   shifted by the measured futures→spot difference; the last minutes (Yahoo is ~10 min delayed)
   come from live spot ticks, or PAX Gold shifted to spot. */
async function goldSpotNow() {
  wantGoldTicks();
  const lt = goldTicks[goldTicks.length - 1];
  if (lt && Date.now() / 1000 - lt.t < 20) return lt.p;
  try { const j = await cached('goldapi', 8000, () => fetchJSON('https://api.gold-api.com/price/XAU', {}, 6000)); return +j.price || null; } catch (_) { return null; }
}
function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
async function goldProxy1m() { // minute bars that track spot gold in real time
  const spot = await goldSpotNow();
  const k = await cached('paxg1m', 8000, () => cryptoCandles('PAXGUSDT', '1m', 300)).catch(() => null);
  let px = k?.candles || [];
  if (px.length && spot && Math.abs(spot - px[px.length - 1].close) / spot < 0.03) {
    const b = spot - px[px.length - 1].close;
    px = px.map(c => ({ ...c, open: c.open + b, high: c.high + b, low: c.low + b, close: c.close + b }));
  } else if (!spot) px = [];
  // real spot ticks win where we have them
  const tc = goldTickCandles().slice(1);
  if (tc.length) px = px.filter(c => c.time < tc[0].time).concat(tc);
  return { spot, px };
}
async function goldFuturesBasis() {
  return cached('goldbasis', 60000, async () => {
    const [f, g] = await Promise.all([yahooRaw('GC=F', '1m', '1d'), goldProxy1m()]);
    const m = new Map(g.px.map(c => [c.time, c.close]));
    const diffs = f.candles.filter(c => m.has(c.time)).slice(-60).map(c => m.get(c.time) - c.close);
    if (diffs.length >= 5) return median(diffs);
    const lf = f.candles[f.candles.length - 1];
    return g.spot && lf && Date.now() / 1000 - lf.time < 1800 ? g.spot - lf.close : (lastBasis.GC?.b ?? null);
  });
}
async function goldSpotCandles(tf, limit) {
  const [fs, basis, g] = await Promise.all([yahooSeries('GC=F', tf), goldFuturesBasis(), goldProxy1m()]);
  if (basis == null || !fs.candles.length) throw new Error('gold basis unavailable');
  lastBasis.GC = { b: basis, t: Date.now() };
  const sh = c => ({ ...c, open: c.open + basis, high: c.high + basis, low: c.low + basis, close: c.close + basis });
  let candles = fs.candles.map(sh);
  // fill the delayed tail with live spot data (only while the gold market is open)
  const raw1 = (await yahooRaw('GC=F', '1m', '1d').catch(() => null))?.candles || [];
  const lastF = raw1.length ? raw1[raw1.length - 1].time : 0, now = Date.now() / 1000;
  let feed = 'COMEX gold → spot';
  if (lastF && now - lastF < 45 * 60) {
    const sec = TF_SEC[tf] || 3600, tail = g.px.filter(c => c.time > lastF);
    for (const c of tail) {
      const b = bucketOf(c.time, sec, fs.anchor), L = candles[candles.length - 1];
      if (L && L.time === b) { L.high = Math.max(L.high, c.high); L.low = Math.min(L.low, c.low); L.close = c.close; }
      else if (!L || b > L.time) candles.push({ time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 });
    }
    if (tail.length) feed += ' + live spot';
  }
  return { symbol: 'XAUUSD', tv: 'OANDA:XAUUSD', currency: 'USD', name: 'Gold spot (XAU/USD)', priceNote: 'spot', feed, candles: candles.slice(-limit) };
}
// old real-time PAXG method, kept as a backup if Yahoo is down
async function goldPaxgCandles(tf, limit) {
  const k = await cryptoCandles('PAXGUSDT', tf, limit);
  const spot = await goldSpotNow(), last = k.candles[k.candles.length - 1]?.close;
  const b = spot && last && Math.abs(spot - last) / last < 0.03 ? spot - last : 0;
  return { symbol: 'XAUUSD', tv: 'OANDA:XAUUSD', currency: 'USD', name: 'Gold spot (XAU/USD)', priceNote: 'spot', feed: 'PAXG ' + (b ? '+ spot adjust' : '(spot feed down)'),
    candles: k.candles.map(c => ({ ...c, open: c.open + b, high: c.high + b, low: c.low + b, close: c.close + b })) };
}

async function yahooCandles(symbol, market, tf, limit) {
  const ys = normYahoo(symbol, market);
  if (ys === 'GC=F') {
    try { return await goldSpotCandles(tf, limit); } catch (_) { }
    try { return await goldPaxgCandles(tf, limit); } catch (_) { /* fall back to plain Yahoo below */ }
  }
  const r = await yahooSeries(ys, tf);
  let candles = r.candles;
  let tv = tvForYahoo(ys), name = r.meta.longName || r.meta.shortName, priceNote = null;
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
  return { symbol: ys, tv, currency: r.meta.currency, name, priceNote, feed: ys.endsWith('=X') ? 'FX (Yahoo)' : 'Yahoo', candles: candles.slice(-limit) };
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

// Firebase web config (Google login + cloud save). Set these 4 env vars on Render → Environment.
// They are public identifiers (safe in the browser); your data is protected by Firestore security rules.
app.get('/api/config', (_, res) => {
  const e = process.env;
  const firebase = e.FIREBASE_API_KEY ? {
    apiKey: e.FIREBASE_API_KEY, authDomain: e.FIREBASE_AUTH_DOMAIN || `${e.FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: e.FIREBASE_PROJECT_ID, appId: e.FIREBASE_APP_ID
  } : null;
  res.json({ firebase });
});

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

function getCandles(market, symbol, tf, fetchLimit = 500) {
  const gold = market === 'forex' && ['XAUUSD', 'GOLD'].includes(symbol.toUpperCase());
  const ttl = gold ? 5000 : tf === '1m' ? 8000 : 20000;
  return cached(`${market}|${symbol.toUpperCase()}|${tf}|${fetchLimit}`, ttl, async () => {
    if (market === 'crypto') return cryptoCandles(symbol, tf, fetchLimit);
    if (market === 'cse') return cseCandles(symbol, tf, fetchLimit);
    return yahooCandles(symbol, market, tf, fetchLimit);
  });
}
app.get('/api/candles', async (req, res) => {
  const market = (req.query.market || 'crypto').toLowerCase();
  const symbol = (req.query.symbol || 'BTCUSDT').trim();
  const tf = TF_SEC[req.query.tf] ? req.query.tf : '1h';
  const limit = Math.min(+req.query.limit || 500, 1000);
  // round the limit up so many different requests share one cached upstream call
  const fetchLimit = limit <= 100 ? 100 : limit <= 500 ? 500 : 1000;
  try {
    const out = await getCandles(market, symbol, tf, fetchLimit);
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

/* ---------- ECONOMIC CALENDAR (high-impact news filter) ---------- */
// Crypto Fear & Greed index (free, alternative.me) — used by the sentiment method
app.get('/api/sentiment', async (_, res) => {
  try {
    const j = await cached('fng', 30 * 60 * 1000, () => fetchJSON('https://api.alternative.me/fng/?limit=1', {}, 8000));
    const d = j?.data?.[0]; res.json({ value: d ? +d.value : null, label: d?.value_classification || null });
  } catch (e) { res.json({ value: null, error: e.message }); }
});

app.get('/api/calendar', async (_, res) => {
  try {
    const rows = await cached('ffcal', 60 * 60 * 1000, () => fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {}, 12000));
    res.json({ events: (Array.isArray(rows) ? rows : []).filter(e => /high|medium/i.test(e.impact || '')).map(e => ({ title: e.title, cur: e.country, t: Date.parse(e.date), impact: e.impact })) });
  } catch (e) { res.json({ events: [], error: e.message }); }
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
    if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://pryme-analyser.onrender.com'; headers['X-Title'] = 'Pryme Quant'; }
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


/* ============================================================
   PRYME AGENT — watches your symbols in the background and sends a
   push notification to your phone / PC when it finds a clean setup.
   - Web Push (works when the app is closed on Android, Windows/Mac Chrome & Edge, iPhone home-screen app)
   - Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY on Render so phones stay subscribed after restarts
     (GET /api/push/newkeys once to get a pair).
   - The watch list lives in memory: every time you open Pryme it re-registers automatically.
   ============================================================ */
let webpush = null; try { webpush = require('web-push'); } catch (_) { }
let VAPID = null;
function vapid() {
  if (VAPID || !webpush) return VAPID;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, temp = false;
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; temp = true; }
  try { webpush.setVapidDetails(process.env.VAPID_SUBJECT || ('mailto:' + (process.env.CONTACT_EMAIL || 'agent@pryme-quant.app')), pub, priv); }
  catch (e) { console.warn('VAPID error', e.message); return null; }
  VAPID = { pub, temp }; return VAPID;
}
const agents = new Map(); // id -> registration
const AG_HTF = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '4h', '4h': '1d', '1d': null };
const okMarket = m => ['forex', 'crypto', 'cse', 'stock'].includes(m);
function cleanWatch(w) {
  return (Array.isArray(w) ? w : []).slice(0, 8).map(x => ({ market: String(x.market || '').toLowerCase(), symbol: String(x.symbol || '').toUpperCase().slice(0, 24), tf: TF_SEC[x.tf] ? x.tf : '1h' }))
    .filter(x => okMarket(x.market) && x.symbol && x.tf !== '1m');
}
app.get('/api/push/key', (_, res) => { const v = vapid(); res.json({ key: v ? v.pub : null, temp: v ? v.temp : true, push: !!v }); });
app.get('/api/push/newkeys', (_, res) => { if (!webpush) return res.status(500).json({ error: 'web-push not installed' }); res.json(webpush.generateVAPIDKeys()); });
app.post('/api/agent/register', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').slice(0, 40); if (!/^[a-z0-9_-]{6,40}$/i.test(id)) return res.status(400).json({ error: 'bad id' });
  if (!agents.has(id) && agents.size >= 300) return res.status(429).json({ error: 'agent is full' });
  const old = agents.get(id) || { alerts: [], sent: {} };
  const keys = (Array.isArray(b.keys) ? b.keys : []).filter(k => k && k.key && PROVIDERS[k.provider]).slice(0, 5).map(k => ({ provider: k.provider, key: String(k.key), model: k.model || '' }));
  agents.set(id, {
    ...old, id, enabled: b.enabled !== false, sub: b.sub && b.sub.endpoint ? b.sub : old.sub || null,
    watch: cleanWatch(b.watch), lang: ['singlish', 'sinhala', 'english'].includes(b.lang) ? b.lang : 'english',
    minScore: Math.max(55, Math.min(90, +b.minScore || 70)), keys, seen: Date.now(), name: String(b.name || '').slice(0, 30)
  });
  ensureScanner();
  res.json({ ok: true, push: !!(agents.get(id).sub && vapid()), key: vapid()?.pub || null, watching: agents.get(id).watch.length, lastScan: agentScan.at });
});
app.get('/api/agent/status', (req, res) => {
  const a = agents.get(String(req.query.id || ''));
  res.json({ registered: !!a, push: !!(a && a.sub), watch: a ? a.watch : [], alerts: a ? a.alerts.slice(0, 20) : [], lastScan: agentScan.at, scanning: agentScan.busy, restartedAt: BOOT });
});
app.post('/api/agent/test', async (req, res) => {
  const a = agents.get(String(req.body?.id || ''));
  if (!a || !a.sub) return res.status(404).json({ error: 'No phone/PC subscribed yet — turn on Agent alerts first.' });
  try { await sendPush(a, { title: 'Pryme Agent ✓', body: a.lang === 'english' ? 'Notifications work. I will tell you when I find a clean setup.' : 'Notifications hari. Hoda setup ekak hambunama mama kiyannam.', url: '/?tab=agent', tag: 'test' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
const BOOT = Date.now();
async function sendPush(a, payload) {
  if (!a.sub || !vapid()) throw new Error('push not set up');
  try { await webpush.sendNotification(a.sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); }
  catch (e) { if (e.statusCode === 404 || e.statusCode === 410) a.sub = null; throw new Error('push failed ' + (e.statusCode || e.message)); }
}

/* --- the agent's own quick scan (pre-filter; the full 29-method check runs when you open the app) --- */
function aEma(v, n) { const k = 2 / (n + 1); let e; return v.map((x, i) => (e = i ? x * k + e * (1 - k) : x, i < n - 1 ? null : e)); }
function aRsi(c, n = 14) { const o = Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } return o; }
function aAtr(cs, n = 14) { const o = []; let a = null; cs.forEach((k, i) => { const tr = i ? Math.max(k.high - k.low, Math.abs(k.high - cs[i - 1].close), Math.abs(k.low - cs[i - 1].close)) : k.high - k.low; a = i < n ? (a == null ? tr : (a * i + tr) / (i + 1)) : (a * (n - 1) + tr) / n; o.push(a); }); return o; }
function htfTrend(h) {
  if (!h || h.length < 60) return 0;
  const c = h.map(x => x.close), e20 = aEma(c, 20), e50 = aEma(c, 50), j = h.length - 1;
  return e20[j] > e50[j] && c[j] > e50[j] ? 1 : e20[j] < e50[j] && c[j] < e50[j] ? -1 : 0;
}
function quickSignal(cs, htf) {
  if (!cs || cs.length < 220) return null;
  const c = cs.map(x => x.close), e20 = aEma(c, 20), e50 = aEma(c, 50), e200 = aEma(c, 200), r = aRsi(c), at = aAtr(cs);
  const i = cs.length - 2, k = cs[i], A = at[i], px = cs[cs.length - 1].close, ht = htfTrend(htf);
  if (!A || !e200[i]) return null;
  for (const dir of [1, -1]) {
    const stack = dir > 0 ? e20[i] > e50[i] && e50[i] > e200[i] && k.close > e200[i] : e20[i] < e50[i] && e50[i] < e200[i] && k.close < e200[i];
    if (!stack || ht === -dir) continue;
    const touch = [0, 1, 2, 3].some(d => dir > 0 ? cs[i - d].low <= e20[i - d] + 0.15 * A : cs[i - d].high >= e20[i - d] - 0.15 * A);
    const body = Math.abs(k.close - k.open), rng = (k.high - k.low) || 1e-9;
    const confirm = (k.close - k.open) * dir > 0 && (k.close - e20[i]) * dir > 0 && body / rng > 0.35;
    if (!touch || !confirm) continue;
    const rsiOk = dir > 0 ? r[i] > 45 && r[i] < 68 : r[i] < 55 && r[i] > 32;
    const slope = (e50[i] - e50[i - 5]) * dir > 0;
    const ext = Math.abs(px - e20[i]) / A; // too far from the mean = late
    if (ext > 1.6) continue;
    const swing = dir > 0 ? Math.min(...cs.slice(i - 10, i + 1).map(x => x.low)) : Math.max(...cs.slice(i - 10, i + 1).map(x => x.high));
    let limit = (e20[i] + e50[i]) / 2; if ((px - limit) * dir < 0.2 * A) limit = px - dir * 0.35 * A;
    const sl = dir > 0 ? Math.min(swing, limit - 1.2 * A) - 0.2 * A : Math.max(swing, limit + 1.2 * A) + 0.2 * A;
    const R = Math.abs(limit - sl);
    if ((px - sl) * dir <= 0.3 * A) continue;
    let score = 50 + (ht === dir ? 15 : 0) + (rsiOk ? 10 : 0) + (body / rng > 0.55 ? 8 : 4) + (slope ? 7 : 0) + (ext < 0.8 ? 6 : 0);
    score = Math.min(95, score);
    return { dir: dir > 0 ? 'BUY' : 'SELL', score, grade: score >= 82 ? 'A+' : score >= 70 ? 'A' : 'B', price: px, limit, sl, tp1: limit + dir * R, tp2: limit + dir * 2 * R, tp3: limit + dir * 3 * R, bar: k.time, htf: ht, rsi: r[i] };
  }
  return null;
}
const nf = v => { const a = Math.abs(v); const d = a >= 1000 ? 2 : a >= 20 ? 3 : 5; return (+v).toFixed(d).replace(/\.?0+$/, m => m.includes('.') ? '' : m); };
const agentScan = { at: 0, busy: false, timer: null };
function ensureScanner() { if (!agentScan.timer) { agentScan.timer = setInterval(scanAll, 4 * 60 * 1000); setTimeout(scanAll, 15000); } }
async function scanAll() {
  if (agentScan.busy) return;
  const live = [...agents.values()].filter(a => a.enabled && a.watch.length && Date.now() - a.seen < 7 * 86400e3);
  if (!live.length) return;
  agentScan.busy = true;
  try {
    const jobs = new Map();
    live.forEach(a => a.watch.forEach(w => { const k = `${w.market}|${w.symbol}|${w.tf}`; if (!jobs.has(k)) jobs.set(k, { ...w, users: [] }); jobs.get(k).users.push(a); }));
    for (const [key, j] of jobs) {
      try {
        const d = await getCandles(j.market, j.symbol, j.tf, 500);
        const h = AG_HTF[j.tf] ? (await getCandles(j.market, j.symbol, AG_HTF[j.tf], 500).catch(() => null))?.candles : null;
        const sig = quickSignal(d.candles, h);
        if (!sig) continue;
        for (const a of j.users) {
          if (sig.score < a.minScore) continue;
          const sk = `${key}|${sig.dir}`, last = a.sent[sk] || 0;
          if (sig.bar * 1000 - last < (TF_SEC[j.tf] || 3600) * 6 * 1000) continue; // same idea already sent recently
          a.sent[sk] = sig.bar * 1000;
          const why = await agentWhy(a, j, sig).catch(() => '');
          const title = `🎯 ${j.symbol} ${j.tf.toUpperCase()} · ${sig.dir} (${sig.grade})`;
          const body = `Limit ${nf(sig.limit)} · Now ${nf(sig.price)} · SL ${nf(sig.sl)} · TP ${nf(sig.tp1)} / ${nf(sig.tp2)}` + (why ? `\n${why}` : '');
          const alert = { t: Date.now(), market: j.market, symbol: j.symbol, tf: j.tf, ...sig, why, title, body };
          a.alerts.unshift(alert); a.alerts = a.alerts.slice(0, 30);
          if (a.sub) sendPush(a, { title, body, url: `/?tab=signals&market=${j.market}&symbol=${encodeURIComponent(j.symbol)}&tf=${j.tf}&go=1`, tag: sk }).catch(e => console.warn('push', e.message));
        }
      } catch (e) { console.warn('agent scan', key, e.message); }
    }
  } finally { agentScan.busy = false; agentScan.at = Date.now(); }
}
async function agentWhy(a, j, sig) {
  if (!a.keys.length) return '';
  const lang = { singlish: 'Singlish (Sinhala written in English letters)', sinhala: 'Sinhala (සිංහල script)', english: 'English' }[a.lang];
  const prompt = `${j.symbol} ${j.tf} ${sig.dir} setup. Price ${nf(sig.price)}, limit ${nf(sig.limit)}, SL ${nf(sig.sl)}, TP1 ${nf(sig.tp1)}. EMA 20/50/200 stacked ${sig.dir === 'BUY' ? 'up' : 'down'}, pullback to EMA20 with a confirmation candle, RSI ${sig.rsi?.toFixed(0)}, higher timeframe ${sig.htf > 0 ? 'up' : sig.htf < 0 ? 'down' : 'flat'}. Write ONE short reason (max 22 words) in ${lang}. Return JSON {"why":"..."}`;
  for (const k of a.keys) {
    try { const o = await callAI({ ...k, system: 'You are a concise trading assistant. Reply only with JSON.', prompt }); const m = /\{[\s\S]*\}/.exec(o.text); if (m) return String(JSON.parse(m[0]).why || '').slice(0, 160); } catch (_) { }
  }
  return '';
}

// a missing file (icon, image, script…) must be a real 404 — never the web page, or app stores reject the icons
app.get('*', (req, res) => {
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).type('text/plain').send('Not found: ' + req.path);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pryme Quant running on http://localhost:${PORT}`));

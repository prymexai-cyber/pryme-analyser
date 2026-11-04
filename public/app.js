/* ============================================================
   PRYME QUANT — frontend
   ============================================================ */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
};

/* ---------------- config ---------------- */
const DEFAULT_SYM = { forex: 'XAUUSD', crypto: 'BTCUSDT', cse: 'JKH.N0000', stock: 'AAPL' };
const PICKS = {
  forex: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'GBPJPY', 'EURJPY', 'NAS100', 'US30'],
  crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'],
  cse: ['JKH.N0000', 'COMB.N0000', 'HNB.N0000', 'SAMP.N0000', 'DIAL.N0000', 'LOLC.N0000', 'EXPO.N0000', 'CTC.N0000', 'HAYL.N0000', 'SLTL.N0000'],
  stock: ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'SPY', 'QQQ']
};
const HTF = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '4h', '4h': '1d', '1d': null };
const TV_INT = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const PROVIDERS = {
  groq: { label: 'Groq', model: 'llama-3.3-70b-versatile' },
  gemini: { label: 'Gemini', model: 'gemini-2.5-flash' },
  openrouter: { label: 'OpenRouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral: { label: 'Mistral', model: 'mistral-small-latest' },
  cerebras: { label: 'Cerebras', model: 'llama-3.3-70b' }
};

/* ---------------- state ---------------- */
const S = {
  market: store.get('pa_market', 'forex'),
  symbol: null,
  tf: store.get('pa_tf', '15m'),
  candles: [], meta: {}, ind: null,
  ws: null, poll: null, view: (store.get('pa_view2', null) || 'pryme'), searchHits: null,
  setups: [], analysis: null, priceLines: [], selected: null,
  news: [],
  settings: Object.assign({ keys: [], lang: 'singlish', riskPct: 1, active: 'demo' }, store.get('pa_settings', {})),
  accounts: store.get('pa_accounts', null),
  signals: store.get('pa_signals', []),      // live AI signals tracked on the chart
  sigStats: store.get('pa_sigstats', []),    // finished signals → win rate
  log: store.get('pa_log', []),
  livePrices: {}, acctView: null, acctTab: 'open',
  autoBusy: false, autoQueue: [], autoRetry: {}, batch: store.get('pa_batch', 0), batchDone: {}
};
S.settings.pro = Object.assign({ enabled: true, mode: 'highwin', minRR: 1.8, minAdx: 18, minSlAtr: 1.3, newsMins: 45, streak: 2, pauseHours: 2, dailyPct: 3 }, S.settings.pro || {});
S.settings.auto = Object.assign({ enabled: true, trigger: 'tp1', onSL: false, expiryBars: 16, autoTake: 'off', minConf: 60, maxOpen: 2 }, S.settings.auto || {});
if (!S.accounts) {
  // migrate older single demo wallet
  const old = store.get('pa_demo', {});
  S.accounts = {
    demo: { USD: old.USD ?? 10000, LKR: old.LKR ?? 1000000, positions: old.positions || [], history: old.history || [] },
    real: { USD: S.settings.balance ?? 0, LKR: S.settings.balanceLKR ?? 0, positions: [], history: [] }
  };
}
S.acctView = S.settings.active;
S.symbol = store.get('pa_sym_' + S.market, DEFAULT_SYM[S.market]);
const saveSettings = () => store.set('pa_settings', S.settings);
const saveAccounts = () => store.set('pa_accounts', S.accounts);
const saveSignals = () => { store.set('pa_signals', S.signals.slice(-60)); store.set('pa_sigstats', S.sigStats.slice(-500)); store.set('pa_batch', S.batch); };
const ACC = () => S.accounts[S.settings.active];
const ACC_LABEL = { demo: 'Demo', real: 'Real' };

/* ---------------- utils ---------------- */
function precisionFor(p, market) {
  if (market === 'stock' || market === 'cse') return 2;
  if (market === 'forex') return p < 20 ? 5 : p < 500 ? 3 : 2;
  if (p < 0.001) return 8; if (p < 1) return 5; if (p < 100) return 4; return 2;
}
const fmt = (v, p) => (v == null || isNaN(v)) ? '—' : (+v).toLocaleString('en-US', { minimumFractionDigits: p ?? S.prec ?? 2, maximumFractionDigits: p ?? S.prec ?? 2 });
const money = (v, cur = 'USD') => (cur === 'LKR' ? 'Rs ' : '$') + (+v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const curOf = market => market === 'cse' ? 'LKR' : 'USD';
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }
async function getJSON(url, opts) { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- indicators ---------------- */
function ema(v, n) { const k = 2 / (n + 1); const o = []; let e; v.forEach((x, i) => { e = i === 0 ? x : x * k + e * (1 - k); o.push(i < n - 1 ? null : e); }); return o; }
function sma(v, n) { const o = []; let s = 0; v.forEach((x, i) => { s += x; if (i >= n) s -= v[i - n]; o.push(i >= n - 1 ? s / n : null); }); return o; }
function rsi(c, n = 14) {
  const o = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return o;
}
function atr(cs, n = 14) {
  const tr = cs.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close)));
  const o = []; let a;
  tr.forEach((t, i) => { if (i < n) { a = (a || 0) + t / n; o.push(i === n - 1 ? a : null); } else { a = (a * (n - 1) + t) / n; o.push(a); } });
  return o;
}
function macd(c) {
  const f = ema(c, 12), s = ema(c, 26);
  const line = c.map((_, i) => f[i] != null && s[i] != null ? f[i] - s[i] : null);
  const start = line.findIndex(x => x != null);
  const sig = new Array(c.length).fill(null);
  if (start >= 0) { const e = ema(line.slice(start), 9); e.forEach((x, i) => sig[start + i] = x); }
  return { line, sig, hist: line.map((x, i) => x != null && sig[i] != null ? x - sig[i] : null) };
}
function bollinger(c, n = 20, k = 2) {
  const m = sma(c, n);
  return c.map((_, i) => { if (m[i] == null) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - m[i]) ** 2; const sd = Math.sqrt(s / n); return { mid: m[i], up: m[i] + k * sd, lo: m[i] - k * sd }; });
}
function adx(cs, n = 14) {
  if (cs.length < n * 2 + 2) return null;
  let trS = 0, pS = 0, mS = 0; const dx = [];
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= n) { trS += tr; pS += pdm; mS += mdm; } else { trS = trS - trS / n + tr; pS = pS - pS / n + pdm; mS = mS - mS / n + mdm; }
    if (i >= n) { const pdi = 100 * pS / trS, mdi = 100 * mS / trS; dx.push({ v: 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1), pdi, mdi }); }
  }
  const last = dx.slice(-n); const a = last.reduce((s, x) => s + x.v, 0) / last.length;
  return { adx: a, pdi: dx[dx.length - 1].pdi, mdi: dx[dx.length - 1].mdi };
}
function swings(cs, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) {
      if (cs[i].high <= cs[i - j].high || cs[i].high < cs[i + j].high) h = false;
      if (cs[i].low >= cs[i - j].low || cs[i].low > cs[i + j].low) l = false;
    }
    if (h) hi.push({ i, p: cs[i].high, t: cs[i].time });
    if (l) lo.push({ i, p: cs[i].low, t: cs[i].time });
  }
  return { hi, lo };
}
function clusterLevels(points, tol) {
  const lv = [];
  points.sort((a, b) => a - b).forEach(p => {
    const L = lv.find(x => Math.abs(x.p - p) <= tol);
    if (L) { L.p = (L.p * L.n + p) / (L.n + 1); L.n++; } else lv.push({ p, n: 1 });
  });
  return lv;
}
function fvgs(cs) {
  const out = []; const start = Math.max(2, cs.length - 80);
  for (let i = start; i < cs.length; i++) {
    const a = cs[i - 2], c = cs[i];
    if (c.low > a.high) out.push({ type: 'bull', top: c.low, bot: a.high, t: c.time, i });
    if (c.high < a.low) out.push({ type: 'bear', top: a.low, bot: c.high, t: c.time, i });
  }
  // keep unfilled
  return out.filter(g => !cs.slice(g.i + 1).some(c => g.type === 'bull' ? c.low <= g.bot : c.high >= g.top)).slice(-6);
}
function patterns(cs) {
  const n = cs.length, out = []; if (n < 3) return out;
  const a = cs[n - 2], b = cs[n - 1];
  const body = c => Math.abs(c.close - c.open), rng = c => c.high - c.low || 1e-9;
  if (a.close < a.open && b.close > b.open && b.close >= a.open && b.open <= a.close) out.push('Bullish engulfing');
  if (a.close > a.open && b.close < b.open && b.close <= a.open && b.open >= a.close) out.push('Bearish engulfing');
  const lw = Math.min(b.open, b.close) - b.low, uw = b.high - Math.max(b.open, b.close);
  if (lw > 2 * body(b) && lw > 0.55 * rng(b)) out.push('Bullish pin bar / hammer');
  if (uw > 2 * body(b) && uw > 0.55 * rng(b)) out.push('Bearish pin bar / shooting star');
  if (body(b) < 0.1 * rng(b)) out.push('Doji (indecision)');
  return out;
}

function analyseIndicators(cs) {
  const c = cs.map(x => x.close), last = cs[cs.length - 1], n = cs.length;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const r = rsi(c), A = atr(cs), M = macd(c), B = bollinger(c), D = adx(cs);
  const sw = swings(cs, n > 300 ? 4 : 3);
  const a = A[n - 1] || (last.high - last.low) || last.close * 0.005;
  const lv = clusterLevels([...sw.hi.slice(-20).map(x => x.p), ...sw.lo.slice(-20).map(x => x.p)], a * 0.6);
  const price = last.close;
  const res = lv.filter(l => l.p > price).sort((x, y) => x.p - y.p).slice(0, 4);
  const sup = lv.filter(l => l.p < price).sort((x, y) => y.p - x.p).slice(0, 4);
  const H = sw.hi.slice(-2), L = sw.lo.slice(-2);
  let structure = 'ranging';
  if (H.length === 2 && L.length === 2) {
    if (H[1].p > H[0].p && L[1].p > L[0].p) structure = 'bullish (HH + HL)';
    else if (H[1].p < H[0].p && L[1].p < L[0].p) structure = 'bearish (LH + LL)';
    else if (H[1].p > H[0].p && L[1].p < L[0].p) structure = 'expanding / volatile';
    else structure = 'contracting / range';
  }
  // BOS / CHoCH (simple)
  let bos = null;
  const lastHi = sw.hi[sw.hi.length - 1], lastLo = sw.lo[sw.lo.length - 1];
  if (lastHi && price > lastHi.p) bos = 'Price broke above last swing high (bullish BOS)';
  if (lastLo && price < lastLo.p) bos = 'Price broke below last swing low (bearish BOS)';
  // fib of last impulse
  let fib = null;
  if (lastHi && lastLo) {
    const up = lastLo.i < lastHi.i, hi = lastHi.p, lo = lastLo.p, d = hi - lo;
    fib = { dir: up ? 'up' : 'down', hi, lo, f382: up ? hi - d * .382 : lo + d * .382, f5: up ? hi - d * .5 : lo + d * .5, f618: up ? hi - d * .618 : lo + d * .618, f786: up ? hi - d * .786 : lo + d * .786 };
  }
  const vols = cs.slice(-21, -1).map(x => x.volume || 0); const avgV = vols.reduce((s, x) => s + x, 0) / (vols.length || 1);
  const out = {
    price, atr: a, ema20: e20[n - 1], ema50: e50[n - 1], ema200: e200[n - 1],
    rsi: r[n - 1], rsiPrev: r[n - 6], macd: M.line[n - 1], macdSig: M.sig[n - 1], macdHist: M.hist[n - 1], macdHistPrev: M.hist[n - 2],
    bb: B[n - 1], adx: D, structure, bos, fib, res, sup, fvg: fvgs(cs), patterns: patterns(cs),
    volRatio: avgV ? (last.volume || 0) / avgV : null,
    swingHi: lastHi?.p, swingLo: lastLo?.p,
    hi20: Math.max(...cs.slice(-20).map(x => x.high)), lo20: Math.min(...cs.slice(-20).map(x => x.low)),
    series: { e20, e50, e200 }
  };
  // RSI divergence (last two swing lows/highs)
  if (L.length === 2 && r[L[1].i] != null && r[L[0].i] != null && L[1].p < L[0].p && r[L[1].i] > r[L[0].i]) out.divergence = 'Bullish RSI divergence';
  if (H.length === 2 && r[H[1].i] != null && r[H[0].i] != null && H[1].p > H[0].p && r[H[1].i] < r[H[0].i]) out.divergence = 'Bearish RSI divergence';
  // confirmation candle: strong close beyond the previous bar, rejection wick, or engulfing
  const conf = k => {
    const c = cs[k], c0 = cs[k - 1]; if (!c || !c0) return { bull: false, bear: false };
    const rg = (c.high - c.low) || 1e-9, body = Math.abs(c.close - c.open);
    const lw = Math.min(c.open, c.close) - c.low, uw = c.high - Math.max(c.open, c.close);
    return {
      bull: c.close > c.open && (c.close > c0.high || (lw > body * 1.5 && (c.close - c.low) / rg > 0.6) || (c0.close < c0.open && c.close >= c0.open)),
      bear: c.close < c.open && (c.close < c0.low || (uw > body * 1.5 && (c.high - c.close) / rg > 0.6) || (c0.close > c0.open && c.close <= c0.open))
    };
  };
  out.conf1 = conf(n - 1); out.conf2 = conf(n - 2);
  out.zones = instZones(cs, out, sw, a);
  out.score = scoreOf(out);
  return out;
}
function scoreOf(I) {
  let s = 0; const p = I.price;
  if (I.ema50 && I.ema200) s += I.ema50 > I.ema200 ? 15 : -15;
  if (I.ema20 && I.ema50) s += I.ema20 > I.ema50 ? 10 : -10;
  if (I.ema20) s += p > I.ema20 ? 8 : -8;
  if (I.structure.startsWith('bullish')) s += 15; if (I.structure.startsWith('bearish')) s -= 15;
  if (I.macdHist != null) s += I.macdHist > 0 ? 8 : -8;
  if (I.macdHist != null && I.macdHistPrev != null) s += I.macdHist > I.macdHistPrev ? 4 : -4;
  if (I.rsi != null) { if (I.rsi > 55) s += 8; else if (I.rsi < 45) s -= 8; if (I.rsi > 75) s -= 10; if (I.rsi < 25) s += 10; }
  if (I.adx && I.adx.adx > 22) s += I.adx.pdi > I.adx.mdi ? 8 : -8;
  if (I.divergence?.startsWith('Bullish')) s += 10; if (I.divergence?.startsWith('Bearish')) s -= 10;
  I.patterns.forEach(x => { if (x.startsWith('Bullish')) s += 6; if (x.startsWith('Bearish')) s -= 6; });
  return Math.max(-100, Math.min(100, Math.round(s)));
}

/* ================================================================
   INSTITUTIONAL LIMIT-ENTRY ENGINE
   Finds where professional / smart-money traders place limit orders and scores the
   overlap ("confluence") of: order blocks · fair value gaps (50%) · OTE fib 0.618–0.786 ·
   liquidity sweeps of equal highs/lows · previous-day high/low · session VWAP ·
   volume point of control · support/resistance · premium/discount of the dealing range.
   ================================================================ */
function instZones(cs, I, sw, a) {
  const n = cs.length, price = cs[n - 1].close, cand = [];
  const add = (side, lo, hi, tag, w = 1) => { if (!(hi >= lo)) [lo, hi] = [hi, lo]; if (hi - lo < a * 0.15) { const m = (lo + hi) / 2; lo = m - a * 0.1; hi = m + a * 0.1; } cand.push({ side, lo, hi, tag, w }); };
  // 1) order blocks: last opposite candle before an impulsive move that broke structure
  const from = Math.max(12, n - 150);
  for (let i = from; i < n - 4; i++) {
    const c = cs[i], prevHi = Math.max(...cs.slice(i - 10, i).map(x => x.high)), prevLo = Math.min(...cs.slice(i - 10, i).map(x => x.low));
    const up = cs[i + 3].close - c.close, dn = c.close - cs[i + 3].close;
    const after = cs.slice(i + 1);
    if (c.close < c.open && up > a * 1.5 && Math.max(...cs.slice(i + 1, i + 4).map(x => x.close)) > prevHi && !after.slice(3).some(x => x.close < c.low)) add('long', c.low, Math.max(c.open, c.close), 'Order block', 1.4);
    if (c.close > c.open && dn > a * 1.5 && Math.min(...cs.slice(i + 1, i + 4).map(x => x.close)) < prevLo && !after.slice(3).some(x => x.close > c.high)) add('short', Math.min(c.open, c.close), c.high, 'Order block', 1.4);
  }
  // 2) fair value gaps (unfilled) — institutions fill to ~50%
  (I.fvg || []).forEach(g => add(g.type === 'bull' ? 'long' : 'short', g.bot, g.top, 'FVG 50%', 1.2));
  // 3) OTE zone of the last impulse
  // OTE for both sides: retracement of the latest up-leg (for buys) and down-leg (for sells)
  const leg = cs.slice(-80);
  const iLo = leg.reduce((m, x, k) => x.low < leg[m].low ? k : m, 0), iHi = leg.reduce((m, x, k) => x.high > leg[m].high ? k : m, 0);
  const upHi = Math.max(...leg.slice(iLo).map(x => x.high)), upLo = leg[iLo].low, dnLo = Math.min(...leg.slice(iHi).map(x => x.low)), dnHi = leg[iHi].high;
  if (upHi - upLo > a * 3) add('long', upHi - (upHi - upLo) * 0.786, upHi - (upHi - upLo) * 0.618, 'OTE 0.618–0.786', 1.2);
  if (dnHi - dnLo > a * 3) add('short', dnLo + (dnHi - dnLo) * 0.618, dnLo + (dnHi - dnLo) * 0.786, 'OTE 0.618–0.786', 1.2);
  // dynamic support / resistance (trend pullbacks)
  [[I.ema20, 'EMA20', 0.6], [I.ema50, 'EMA50', 0.8]].forEach(([v, t, w]) => { if (v) add(v < price ? 'long' : 'short', v - a * 0.2, v + a * 0.2, t, w); });
  // 4) liquidity: equal highs/lows and sweeps
  const eqh = [], eql = [];
  const hs = sw.hi.slice(-12), ls = sw.lo.slice(-12);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) if (Math.abs(hs[i].p - hs[j].p) < a * 0.2) eqh.push(Math.max(hs[i].p, hs[j].p));
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) if (Math.abs(ls[i].p - ls[j].p) < a * 0.2) eql.push(Math.min(ls[i].p, ls[j].p));
  const recent = cs.slice(-25);
  let sweepLong = null, sweepShort = null;
  ls.forEach(l => { if (recent.some(x => x.low < l.p - a * 0.05) && recent[recent.length - 1].close > l.p) sweepLong = l.p; });
  hs.forEach(h => { if (recent.some(x => x.high > h.p + a * 0.05) && recent[recent.length - 1].close < h.p) sweepShort = h.p; });
  if (sweepLong) add('long', sweepLong - a * 0.1, sweepLong + a * 0.4, 'Liquidity sweep', 1.5);
  if (sweepShort) add('short', sweepShort - a * 0.4, sweepShort + a * 0.1, 'Liquidity sweep', 1.5);
  // 5) previous day high / low (intraday charts)
  const day = t => Math.floor(t / 86400), today = day(cs[n - 1].time);
  const yd = cs.filter(x => day(x.time) === today - 1 || (day(x.time) < today && day(x.time) >= today - 3 && !cs.some(y => day(y.time) === today - 1)));
  let pdh = null, pdl = null;
  if (yd.length) {
    pdh = Math.max(...yd.map(x => x.high)); pdl = Math.min(...yd.map(x => x.low));
    // role reversal: a broken PDH becomes support, a broken PDL becomes resistance
    add(pdl < price ? 'long' : 'short', pdl - a * 0.15, pdl + a * 0.15, pdl < price ? 'Prev-day low' : 'PDL flip', 1);
    add(pdh < price ? 'long' : 'short', pdh - a * 0.15, pdh + a * 0.15, pdh < price ? 'PDH flip' : 'Prev-day high', 1);
  }
  // 6) session VWAP (today)
  const td = cs.filter(x => day(x.time) === today);
  let vwap = null;
  if (td.length >= 3) { let pv = 0, v = 0; td.forEach(x => { const w = x.volume || 1; pv += (x.high + x.low + x.close) / 3 * w; v += w; }); vwap = pv / v; add(vwap < price ? 'long' : 'short', vwap - a * 0.15, vwap + a * 0.15, 'VWAP', 0.9); }
  // 7) volume point of control (last 200 bars)
  const win = cs.slice(-200), lo = Math.min(...win.map(x => x.low)), hi = Math.max(...win.map(x => x.high)), bins = new Array(40).fill(0), bw = (hi - lo) / 40 || 1;
  win.forEach(x => { const k = Math.min(39, Math.max(0, Math.floor(((x.high + x.low + x.close) / 3 - lo) / bw))); bins[k] += x.volume || 1; });
  const poc = lo + (bins.indexOf(Math.max(...bins)) + 0.5) * bw;
  add(poc < price ? 'long' : 'short', poc - bw / 2, poc + bw / 2, 'Volume POC', 0.9);
  // 8) support / resistance
  (I.sup || []).forEach(l => add('long', l.p - a * 0.15, l.p + a * 0.15, `Support ×${l.n}`, 0.7 + 0.15 * Math.min(l.n, 4)));
  (I.res || []).forEach(l => add('short', l.p - a * 0.15, l.p + a * 0.15, `Resistance ×${l.n}`, 0.7 + 0.15 * Math.min(l.n, 4)));
  // dealing range → premium / discount
  const rng = cs.slice(-100), rH = Math.max(...rng.map(x => x.high)), rL = Math.min(...rng.map(x => x.low)), eq = (rH + rL) / 2;
  I.keys = { pdh, pdl, vwap, poc, eq, rangeHigh: rH, rangeLow: rL, eqh: [...new Set(eqh)].slice(-3), eql: [...new Set(eql)].slice(-3), sweepLong, sweepShort };
  // merge overlapping candidates into confluence zones
  const zones = [];
  ['long', 'short'].forEach(side => {
    const list = cand.filter(c => c.side === side && (side === 'long' ? c.hi < price - a * 0.2 : c.lo > price + a * 0.2) && Math.abs((c.lo + c.hi) / 2 - price) < a * 6);
    list.sort((x, y) => side === 'long' ? y.hi - x.hi : x.lo - y.lo);
    const used = new Set();
    list.forEach((c, i) => {
      if (used.has(i)) return;
      const grp = [c]; used.add(i);
      list.forEach((d, j) => { if (!used.has(j) && d.lo <= c.hi + a * 0.3 && d.hi >= c.lo - a * 0.3) { grp.push(d); used.add(j); } });
      const tags = [...new Set(grp.map(g => g.tag.replace(/ ×\d+/, '')))];
      const zlo = Math.min(...grp.map(g => g.lo)), zhi = Math.max(...grp.map(g => g.hi));
      // premium / discount of the current dealing leg (ICT): buy below 50% of the up-leg, sell above 50% of the down-leg
      const eqL = upHi - upLo > a * 3 ? (upHi + upLo) / 2 : eq, eqS = dnHi - dnLo > a * 3 ? (dnHi + dnLo) / 2 : eq;
      const inDisc = side === 'long' ? (zlo + zhi) / 2 < eqL : (zlo + zhi) / 2 > eqS;
      const sweep = tags.includes('Liquidity sweep');
      let score = grp.reduce((t, g) => t + g.w, 0) / 1.2 + (inDisc ? 1 : -1) + (sweep ? 0.5 : 0);
      // proximal half: buy the upper half of a demand zone, sell the lower half of a supply zone
      const entry = side === 'long' ? zhi - (zhi - zlo) * 0.35 : zlo + (zhi - zlo) * 0.35;
      zones.push({ side, lo: zlo, hi: zhi, entry, tags: grp.map(g => g.tag).filter((t, k, arr) => arr.indexOf(t) === k), kinds: tags.length, score: +score.toFixed(2), sweep, premiumDiscount: inDisc });
    });
  });
  return zones.filter(z => z.kinds >= 2 || z.sweep).sort((x, y) => y.score - x.score).slice(0, 8);
}
// turn the best confluence zones into BUY / SELL LIMIT setups
function limitSetups(I, dir) {
  const a = I.atr, out = [];
  (I.zones || []).forEach(z => {
    if (dir === 'long' && z.side !== 'long') return;
    if (dir === 'short' && z.side !== 'short') return;
    if (!z.premiumDiscount && !z.sweep && z.kinds < 3) return; // longs in discount, shorts in premium (or very strong confluence)
    const long = z.side === 'long', sg = long ? 1 : -1;
    // stop beyond the zone and the swing that built it
    const swingBeyond = long ? Math.min(z.lo, ...(I.sup || []).filter(l => l.p < z.lo && l.p > z.lo - a * 1.2).map(l => l.p)) : Math.max(z.hi, ...(I.res || []).filter(l => l.p > z.hi && l.p < z.hi + a * 1.2).map(l => l.p));
    const sl = swingBeyond - sg * a * 0.3;
    const R = Math.abs(z.entry - sl);
    // targets at opposing liquidity
    const K = I.keys || {};
    const opp = (long ? [...(I.res || []).map(l => l.p), K.pdh, ...(K.eqh || []), K.rangeHigh] : [...(I.sup || []).map(l => l.p), K.pdl, ...(K.eql || []), K.rangeLow])
      .filter(v => v && (v - z.entry) * sg > R * 0.7).sort((x, y) => (x - y) * sg);
    const tp1 = z.entry + sg * R, tp2 = opp.find(v => (v - z.entry) * sg >= R * 2) ?? z.entry + sg * R * 2.5, tp3 = opp.find(v => (v - tp2) * sg > R * 0.5) ?? z.entry + sg * R * 3.5;
    out.push({
      name: `${long ? 'Buy' : 'Sell'} limit · ${z.tags.slice(0, 3).join(' + ')}`, direction: z.side,
      entry: z.entry, stopLoss: sl, tp1, tp2, tp3, zone: { lo: z.lo, hi: z.hi },
      confidence: Math.min(85, Math.round(50 + z.score * 5)),
      reasoning: `Institutional limit zone ${fmt(z.lo)}–${fmt(z.hi)} with ${z.kinds} confluences (${z.tags.join(', ')})${z.sweep ? ', liquidity already swept' : ''}, in ${long ? 'discount' : 'premium'}. Stop beyond the zone and its swing; targets at the next liquidity.`
    });
  });
  return out.slice(0, 2);
}

/* ---------------- quant baseline setups ---------------- */
function quantSetups(I, htfBias) {
  const p = I.price, a = I.atr; const out = [];
  let score = I.score + (htfBias === 'bullish' ? 12 : htfBias === 'bearish' ? -12 : 0);
  const dir = score > 12 ? 'long' : score < -12 ? 'short' : 'range';
  const mk = (name, d, entry, sl, extra = {}) => {
    const r = Math.abs(entry - sl), sg = d === 'long' ? 1 : -1;
    let tp3 = entry + sg * r * 4;
    const tgt = d === 'long' ? I.res.find(x => x.p > entry + r * 2.5) : I.sup.find(x => x.p < entry - r * 2.5);
    if (tgt) tp3 = tgt.p;
    return { name, direction: d, entry, stopLoss: sl, tp1: entry + sg * r * 1.5, tp2: entry + sg * r * 2.5, tp3, confidence: extra.conf || 50, reasoning: extra.why || '' };
  };
  const clampSL = (entry, raw, d) => { const sg = d === 'long' ? -1 : 1; let dist = Math.abs(entry - raw); dist = Math.min(Math.max(dist, a * 1.0), a * 3); return entry + sg * dist; };
  if (dir === 'long' || dir === 'range') {
    const s1 = I.sup[0]?.p ?? p - a * 1.5;
    if (dir === 'long') out.push(mk('Trend continuation (market)', 'long', p, clampSL(p, (I.swingLo ?? p - a * 1.5) - a * 0.3, 'long'), { conf: 55 + Math.min(20, score / 4), why: 'Momentum + trend aligned, stop below last swing low.' }));
    const pull = Math.max(s1, I.ema20 && I.ema20 < p ? I.ema20 : s1);
    out.push(mk('Pullback buy at support / EMA20', 'long', pull, clampSL(pull, s1 - a * 0.5, 'long'), { conf: dir === 'long' ? 62 : 50, why: 'Wait for price to retrace into support zone.' }));
    if (I.fib && I.fib.dir === 'up') out.push(mk('Fib 61.8% golden-zone buy', 'long', I.fib.f618, clampSL(I.fib.f618, I.fib.f786 - a * 0.3, 'long'), { conf: 55, why: 'Deep retracement into the 0.618 level of the last impulse.' }));
    const r1 = I.res[0]?.p ?? I.hi20;
    out.push(mk('Breakout buy above resistance', 'long', r1 + a * 0.15, clampSL(r1 + a * 0.15, r1 - a * 0.9, 'long'), { conf: 48, why: 'Stop order catches a breakout with momentum.' }));
  }
  if (dir === 'short' || dir === 'range') {
    const r1 = I.res[0]?.p ?? p + a * 1.5;
    if (dir === 'short') out.push(mk('Trend continuation (market)', 'short', p, clampSL(p, (I.swingHi ?? p + a * 1.5) + a * 0.3, 'short'), { conf: 55 + Math.min(20, -score / 4), why: 'Momentum + trend aligned, stop above last swing high.' }));
    const pull = Math.min(r1, I.ema20 && I.ema20 > p ? I.ema20 : r1);
    out.push(mk('Pullback sell at resistance / EMA20', 'short', pull, clampSL(pull, r1 + a * 0.5, 'short'), { conf: dir === 'short' ? 62 : 50, why: 'Wait for price to retrace into resistance zone.' }));
    if (I.fib && I.fib.dir === 'down') out.push(mk('Fib 61.8% golden-zone sell', 'short', I.fib.f618, clampSL(I.fib.f618, I.fib.f786 + a * 0.3, 'short'), { conf: 55, why: 'Deep retracement into the 0.618 level of the last impulse.' }));
    const s1 = I.sup[0]?.p ?? I.lo20;
    out.push(mk('Breakdown sell below support', 'short', s1 - a * 0.15, clampSL(s1 - a * 0.15, s1 + a * 0.9, 'short'), { conf: 48, why: 'Stop order catches a breakdown with momentum.' }));
  }
  const lim = limitSetups(I, dir);
  return { bias: dir === 'long' ? 'BULLISH' : dir === 'short' ? 'BEARISH' : 'NEUTRAL', score, setups: lim.concat(out.filter(o => !lim.some(l => l.direction === o.direction && Math.abs(l.entry - o.entry) < a * 0.4))).slice(0, 4) };
}

/* ---------------- sizing ---------------- */
function quoteFactor(market, sym, price) {
  if (market !== 'forex') return 1;
  const s = sym.toUpperCase();
  if (/^[A-Z]{6}$/.test(s)) {
    if (s.endsWith('USD')) return 1;
    if (s.startsWith('USD')) return 1 / price;
    return 1; // cross pairs: approximate
  }
  return 1;
}
function contractSize(market, sym) {
  const s = sym.toUpperCase();
  if (market !== 'forex') return 1;
  if (s === 'XAUUSD' || s === 'GOLD') return 100;
  if (s === 'XAGUSD' || s === 'SILVER') return 5000;
  if (/^[A-Z]{6}$/.test(s)) return 100000;
  return 1;
}
function sizing(setup, market, sym) {
  const cur = curOf(market);
  const bal = +ACC()[cur] || 0;
  const riskAmt = bal * (+S.settings.riskPct || 1) / 100;
  const f = quoteFactor(market, sym, setup.entry);
  const dist = Math.abs(setup.entry - setup.stopLoss) || 1e-9;
  let units = riskAmt / (dist * f);
  let note = '';
  if (market === 'stock' || market === 'cse') {
    units = Math.floor(units);
    const maxU = Math.floor(bal / setup.entry);
    if (units > maxU) { units = maxU; note = 'Capped to what your balance can buy (no leverage).'; }
  }
  const cs = contractSize(market, sym);
  // brokers can't open less than their minimum size → round to it and say what the real risk becomes
  let minNote = '';
  if (market === 'forex' && cs > 1) {
    const lots = Math.max(0.01, Math.floor(units / cs * 100) / 100);
    if (units / cs < 0.01) minNote = `Minimum is 0.01 lot — real risk ${money(dist * cs * 0.01 * f, cur)} (${(dist * cs * 0.01 * f / (bal || 1) * 100).toFixed(1)}% of balance)`;
    units = lots * cs;
  } else if (market === 'crypto') {
    const st = Math.pow(10, Math.floor(Math.log10(100 / (setup.entry || 1))));
    const u = Math.max(st, Math.floor(units / st) * st);
    if (units < st) minNote = `Minimum size ${st} — real risk ${money(dist * st * f, cur)}`;
    units = +u.toFixed(8);
  } else if (units < 1 && bal >= setup.entry) { units = 1; minNote = 'Minimum 1 share'; }
  if (minNote) note = (note ? note + ' ' : '') + minNote;
  const notional = units * setup.entry * (market === 'forex' && sym.toUpperCase().startsWith('USD') ? 1 / setup.entry : 1);
  const lev = bal ? notional / bal : 0;
  const pnl = tp => Math.abs(tp - setup.entry) * units * f;
  return {
    bal, cur, riskAmt: dist * units * f, units, lots: cs > 1 ? units / cs : null, notional, lev, note,
    p1: pnl(setup.tp1), p2: pnl(setup.tp2), p3: pnl(setup.tp3), factor: f
  };
}

/* ---------------- validation of AI setups ---------------- */
function cleanSetups(raw, I) {
  const p = I.price, a = I.atr;
  const list = (Array.isArray(raw) ? raw : []).map(s => {
    const d = String(s.direction || s.side || '').toLowerCase().includes('s') && !String(s.direction).toLowerCase().includes('buy') ? 'short' : 'long';
    const dir = /sell|short/i.test(s.direction || s.side || '') ? 'short' : /buy|long/i.test(s.direction || s.side || '') ? 'long' : d;
    let entry = +s.entry, sl = +(s.stopLoss ?? s.sl), tps = [+(s.tp1), +(s.tp2), +(s.tp3)].filter(x => isFinite(x) && x > 0);
    if (!isFinite(entry) || entry <= 0) return null;
    if (Math.abs(entry - p) > a * 8) return null; // unrealistic
    const sg = dir === 'long' ? 1 : -1;
    if (!isFinite(sl) || (sl - entry) * sg >= 0) sl = entry - sg * a * 1.5;
    const r = Math.abs(entry - sl);
    if (r < a * 0.25) sl = entry - sg * a * 0.8;
    const R = Math.abs(entry - sl);
    tps = tps.filter(t => (t - entry) * sg > 0).sort((x, y) => sg * (x - y));
    while (tps.length < 3) tps.push(entry + sg * R * [1.5, 2.5, 4][tps.length]);
    return { name: s.name || s.title || 'Setup', direction: dir, entry, stopLoss: sl, tp1: tps[0], tp2: tps[1], tp3: tps[2], confidence: Math.max(1, Math.min(99, Math.round(+s.confidence || 50))), reasoning: s.reasoning || s.reason || '' };
  }).filter(Boolean);
  return list;
}
function orderTypeOf(s, price, a) {
  const tol = a * 0.1;
  if (s.direction === 'long') return s.entry < price - tol ? 'BUY LIMIT' : s.entry > price + tol ? 'BUY STOP' : 'MARKET BUY';
  return s.entry > price + tol ? 'SELL LIMIT' : s.entry < price - tol ? 'SELL STOP' : 'MARKET SELL';
}

/* ---------------- chart ---------------- */
let chart, candleS, volS, e20S, e50S, e200S;
function initChart() {
  const el = $('#chart');
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    // TradingView's own dark theme (same colours as tradingview.com)
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#b2b5be', fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif', fontSize: 12 },
    grid: { vertLines: { color: 'rgba(42,46,57,0.6)' }, horzLines: { color: 'rgba(42,46,57,0.6)' } },
    rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.1, bottom: 0.2 } },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8 },
    crosshair: { mode: 0, vertLine: { color: '#758696', style: 3, labelBackgroundColor: '#4c525e' }, horzLine: { color: '#758696', style: 3, labelBackgroundColor: '#4c525e' } },
    localization: { timeFormatter: t => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) }
  });
  candleS = chart.addCandlestickSeries({ upColor: '#089981', downColor: '#f23645', borderVisible: false, wickUpColor: '#089981', wickDownColor: '#f23645' });
  volS = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  const line = c => chart.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  e20S = line('#2962ff'); e50S = line('#ff9800'); e200S = line('#ab47bc');
  chart.subscribeCrosshairMove(prm => tvLegend(prm && prm.time));
  // show "Live ⟫" when you scroll away from the latest candles or squash the price axis
  const btn = $('#goLiveBtn');
  if (btn) {
    btn.addEventListener('click', () => goLive());
    const check = () => {
      const r = chart.timeScale().getVisibleLogicalRange(), n = S.candles.length;
      let away = !!(r && n && r.to < n - 2);
      try { away = away || chart.priceScale('right').options().autoScale === false; } catch { }
      btn.classList.toggle('hidden', !away);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(check);
    el.addEventListener('pointerup', () => setTimeout(check, 50));
    el.addEventListener('wheel', () => setTimeout(check, 50), { passive: true });
  }
}
function drawSeries() {
  const cs = S.candles; if (!cs.length) return;
  S.prec = precisionFor(cs[cs.length - 1].close, S.market);
  candleS.applyOptions({ priceFormat: { type: 'price', precision: S.prec, minMove: 1 / 10 ** S.prec } });
  candleS.setData(cs.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  volS.setData(cs.map(c => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)' })));
  const I = S.ind;
  const ln = arr => cs.map((c, i) => arr[i] == null ? null : { time: c.time, value: arr[i] }).filter(Boolean);
  e20S.setData(ln(I.series.e20)); e50S.setData(ln(I.series.e50)); e200S.setData(ln(I.series.e200));
}
/* Jump to the live candles with a fresh price scale — used on every symbol / timeframe change
   (if you dragged the price axis on one chart, the next chart would otherwise open on the old price range) */
function goLive(bars = 150) {
  if (!chart) return;
  try {
    chart.priceScale('right').applyOptions({ autoScale: true });
    ['vol', 'rsi', 'macd'].forEach(id => { try { chart.priceScale(id).applyOptions({ autoScale: true }); } catch { } });
    const ts = chart.timeScale(), n = S.candles.length;
    if (n > bars) ts.setVisibleLogicalRange({ from: n - bars, to: n + 8 }); else ts.fitContent();
    ts.scrollToRealTime();
  } catch { }
  const b = document.getElementById('goLiveBtn'); if (b) b.classList.add('hidden');
}
function clearLines() { S.priceLines.forEach(l => { try { candleS.removePriceLine(l); } catch { } }); S.priceLines = []; S.setupMarker = null; updateMarkers(); }
function drawSetupLines(idx) {
  clearLines();
  const s = S.setups[idx]; if (!s) return;
  S.selected = idx;
  const add = (price, color, title, style = 0, w = 2) => S.priceLines.push(candleS.createPriceLine({ price, color, lineWidth: w, lineStyle: style, axisLabelVisible: true, title }));
  const taken = chartItems().some(p => p.sigId && p.sigId === s.sigId);
  const busy = chartItems().length > 0;
  if (!taken) {
  add(s.entry, '#4ea8ff', `SETUP #${idx + 1} ENTRY`, 0, 2);
  add(s.stopLoss, '#ff4d6d', 'SL', 0, 2);
  add(s.tp1, '#19e3a2', 'TP1', 2, 1);
  add(s.tp2, '#19e3a2', 'TP2', 2, 2);
  add(s.tp3, '#19e3a2', 'TP3', 3, 1);
  }
  // faint lines for other setups' entries (hidden while a trade is running, to keep the chart clean)
  if (!busy) S.setups.forEach((o, i) => { if (i !== idx) add(o.entry, 'rgba(78,168,255,.35)', `#${i + 1}`, 1, 1); });
  const last = S.candles[S.candles.length - 1];
  S.setupMarker = { time: last.time, position: s.direction === 'long' ? 'belowBar' : 'aboveBar', color: s.direction === 'long' ? '#19e3a2' : '#ff4d6d', shape: s.direction === 'long' ? 'arrowUp' : 'arrowDown', text: `#${idx + 1} ${s.direction === 'long' ? 'BUY' : 'SELL'}` };
  updateMarkers(); drawBoxes(); S.lvlHidden = false; renderLvlBox();
  $$('.setup').forEach((el, i) => el.classList.toggle('sel', i === idx));
  renderLvlBox();
}
// floating levels panel over the TradingView chart
function renderLvlBox() {
  const box = $('#lvlBox'); if (!box) return;
  if (S.lvlHidden) { box.classList.add('hidden'); return; }
  const pos = chartItems();
  let s = S.setups[S.selected];
  if (s && pos.some(p => p.sigId && p.sigId === s.sigId)) s = null; // already taken → show the trade, not the idea
  const px = S.candles.length ? S.candles[S.candles.length - 1].close : null;
  if (!s && !pos.length) { box.classList.add('hidden'); return; }
  let html = '';
  if (s) {
    const sg = s.direction === 'long' ? 1 : -1, pl = px != null ? (px - s.entry) * sg : null;
    html += `<div class="lb-head"><span class="tag ${s.direction}">${s.direction === 'long' ? 'BUY' : 'SELL'}</span><b>Setup #${S.selected + 1}</b> <span style="color:var(--dim)">${s.grade || ''} · ${s.confidence}%</span><button data-lb-close title="Hide">✕</button></div>
    <div class="r en"><span>ENTRY</span><b>${fmt(s.entry)}</b></div>
    <div class="r sl"><span>STOP LOSS</span><b>${fmt(s.stopLoss)}</b></div>
    <div class="r tp"><span>TP1</span><b>${fmt(s.tp1)}</b></div>
    <div class="r tp"><span>TP2</span><b>${fmt(s.tp2)}</b></div>
    <div class="r tp"><span>TP3</span><b>${fmt(s.tp3)}</b></div>
    ${px != null ? `<div class="r now"><span>NOW</span><b class="${pl >= 0 ? 'up' : 'down'}">${fmt(px)} (${pl >= 0 ? '+' : ''}${fmt(pl)})</b></div>` : ''}`;
  } else {
    html += `<div class="lb-head"><b>Open positions</b><button data-lb-close title="Hide">✕</button></div>`;
  }
  pos.forEach(p => {
    const pl = px != null && p.status === 'open' ? plOf(p, px) : null;
    const st = p.status === 'pending' ? p.type : p.tp1Hit ? 'TP1 ✓ · SL at entry' : 'In trade';
    html += `<div class="lb-pos"><div class="r"><span><span class="tag ${p.dir}">${p.dir === 'long' ? 'BUY' : 'SELL'}</span> ${esc(p.code || '')} ${p.acc === 'real' ? 'REAL' : 'DEMO'} · ${esc(st)}</span><b class="${pl == null ? '' : pl >= 0 ? 'up' : 'down'}">${pl == null ? '' : (pl >= 0 ? '+' : '') + money(pl, p.cur)}</b></div>
      ${p.status === 'open' && px != null ? `<div class="r"><span>Pips</span><b class="${pipsOpen(p, px) >= 0 ? 'up' : 'down'}">${fmtPips(pipsOpen(p, px))}</b></div>` : ''}
      <div class="r"><span>E ${fmt(p.entry, p.prec)} · SL ${fmt(p.sl, p.prec)}</span><span>TP ${p.tp1Hit ? '✓' : fmt(p.tp1, p.prec)} / ${fmt(p.tp2, p.prec)}</span></div></div>`;
  });
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function tvSymbol() {
  if (S.meta && S.meta.tv) return S.meta.tv;
  const s = S.symbol.toUpperCase();
  if (S.market === 'crypto') return 'BINANCE:' + normCrypto(s);
  if (S.market === 'cse') return 'CSELK:' + (s.includes('.') ? s : s + '.N0000');
  if (S.market === 'forex') {
    const m = { XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', NAS100: 'OANDA:NAS100USD', US30: 'OANDA:US30USD', SPX500: 'OANDA:SPX500USD', USOIL: 'TVC:USOIL' };
    return m[s] || 'FX_IDC:' + s.replace('/', '');
  }
  return s;
}
// Two views: the real TradingView live chart, and the Pryme positions chart (entry / SL / TP boxes drawn on it)
// ONE chart only: TradingView's chart with your trades drawn on it.
//  - default: TradingView Lightweight Charts (entry / SL / TP lines + zones, like the reference app)
//  - if the TradingView Advanced Charts library is installed (public/charting_library), that full chart is used instead
function setView() {
  const adv = hasAdvanced();
  S.view = adv ? 'tv' : 'pryme';
  $('#tvWrap').classList.toggle('hidden', !adv);
  $('#chart').classList.toggle('hidden', adv);
  $('#posLayer').classList.toggle('hidden', adv);
  const lk = $('#tvLink'); if (lk) lk.href = 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(tvSymbol());
  const bd = $('#tvBadge'); if (bd) bd.textContent = adv ? '● LIVE · TradingView Advanced' : '● LIVE · TradingView chart';
  $('#tvLegend').classList.toggle('hidden', adv);
  if (adv) ensureAdvanced();
  else setTimeout(() => { try { drawBoxes(); } catch { } }, 50);
}

/* ---------------- data loading / live ---------------- */
/* Binance is called straight from the browser (your own IP) so the shared Render server never gets banned. */
const BN_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com'];
const bnCache = new Map();
function normCrypto(s) {
  s = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/(USDT|USDC|BTC|ETH|FDUSD|BUSD)$/.test(s)) s += 'USDT';
  return s;
}
async function bnGet(path, ttl = 4000) {
  const hit = bnCache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  let lastErr;
  for (const h of BN_HOSTS) {
    try {
      const r = await fetch(h + path);
      if (!r.ok) throw new Error('Binance HTTP ' + r.status);
      const v = await r.json();
      bnCache.set(path, { t: Date.now(), v });
      if (bnCache.size > 80) bnCache.delete(bnCache.keys().next().value);
      return v;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function binanceKlines(sym, tf, limit) {
  const rows = await bnGet(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${Math.min(limit, 1000)}`, tf === '1m' ? 4000 : 8000);
  return rows.map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
}
const isGold = s => ['XAUUSD', 'GOLD'].includes(String(s).toUpperCase());
let goldBasis = null;
async function goldClientCandles(tf, limit) {
  const [raw, gs] = await Promise.all([binanceKlines('PAXGUSDT', tf, limit), getJSON('/api/goldspot' + (tf === '1m' ? '?m1=1' : '')).catch(() => ({}))]);
  if (!raw.length) throw new Error('no PAXG data');
  const last = raw[raw.length - 1].close;
  if (gs.spot && Math.abs(gs.spot - last) / last < 0.03) goldBasis = gs.spot - last;
  const b = goldBasis ?? 0;
  let candles = raw.map(c => ({ ...c, open: c.open + b, high: c.high + b, low: c.low + b, close: c.close + b }));
  let feed = goldBasis != null ? 'PAXG + spot adjust' : 'PAXG (spot feed down)';
  if (tf === '1m' && gs.candles1m?.length) {
    const from = gs.candles1m[0].time;
    candles = candles.filter(c => c.time < from).concat(gs.candles1m).slice(-limit);
    feed = 'live spot ticks';
  }
  return { symbol: 'XAUUSD', tv: 'OANDA:XAUUSD', currency: 'USD', name: 'Gold spot (XAU/USD)', priceNote: 'spot', feed, candles };
}
async function fetchCandles(market, symbol, tf, limit = 500) {
  if (market === 'crypto') {
    try { const s = normCrypto(symbol); return { symbol: s, tv: 'BINANCE:' + s, feed: 'Binance live', candles: await binanceKlines(s, tf, limit) }; }
    catch (e) { /* fall back to server below */ }
  }
  if (market === 'forex' && isGold(symbol)) {
    // server builds gold like OANDA:XAUUSD (same session hours + live spot); browser PAXG is the backup
    try { const d = await getJSON(`/api/candles?market=forex&symbol=XAUUSD&tf=${tf}&limit=${limit}`); if (d.candles?.length) return d; } catch (e) { }
    return goldClientCandles(tf, limit);
  }
  return getJSON(`/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`);
}
let cryptoList = null;
async function searchCryptoLocal(q) {
  if (!cryptoList) {
    const rows = await bnGet('/api/v3/ticker/price', 6 * 3600 * 1000);
    cryptoList = rows.map(r => r.symbol).filter(s => /USDT$/.test(s)).sort();
  }
  const qq = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pri = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const list = qq ? cryptoList.filter(s => s.startsWith(qq)).concat(cryptoList.filter(s => !s.startsWith(qq) && s.includes(qq))) : pri.concat(cryptoList.filter(s => !pri.includes(s)));
  return list.slice(0, 30).map(s => ({ symbol: s, name: s.replace(/USDT$/, '') + ' / Tether' }));
}
function setLive(on, label) { const p = $('#livePill'); p.classList.toggle('on', on); p.querySelector('span').textContent = label || (on ? 'LIVE' : 'OFFLINE'); }
function stopLive() { if (S.ws) { try { S.ws.close(); } catch { } S.ws = null; } clearInterval(S.poll); }

async function loadMarket(opts = {}) {
  stopLive(); clearLines();
  S.setups = []; S.selected = null; renderResult(null); $('#lvlBox').classList.add('hidden');
  S.meta = {}; S.candles = []; S.ind = null;
  $('#lastPrice').textContent = '—'; $('#lastChg').textContent = ''; $('#indRow').innerHTML = '';
  $('#symTitle').textContent = S.symbol.toUpperCase();
  $('#symSub').textContent = 'Loading data…';
  try { candleS.setData([]); volS.setData([]); e20S.setData([]); e50S.setData([]); e200S.setData([]); } catch { } // never show the previous symbol's candles
  setView(); // show the right TradingView chart straight away
  $('#chartMsg').classList.add('hidden');
  setLive(false, 'LOADING');
  try {
    const d = await fetchCandles(S.market, S.symbol, S.tf);
    S.meta = d;
    S.candles = d.candles || [];
    if (S.candles.length < 30 && S.market !== 'cse') throw new Error('Not enough data for this symbol/timeframe.');
    if (!S.candles.length) throw new Error('No price data returned.');
    S.ind = analyseIndicators(S.candles);
    S.loadedKey = `${S.market}|${S.symbol.toUpperCase()}`;
    drawSeries(); goLive();
    updateHeader(); renderIndicators(); updateMarkers(); drawPositions(); renderLvlBox(); tvLegend();
    $('#symSub').textContent = [d.name, d.tv || d.symbol, S.market.toUpperCase(), S.tf, d.feed ? 'feed: ' + d.feed : ''].filter(Boolean).join(' · ');
    if (d.priceNote && d.priceNote.startsWith('futures')) { const m = $('#chartMsg'); m.textContent = 'Spot price feed is busy — showing futures prices for now (slightly higher than spot). Chart is set to futures so levels match.'; m.classList.remove('hidden'); }
    if (d.limited) { const m = $('#chartMsg'); m.textContent = 'CSE history is limited right now — the chart fills in as live prices come in. Switch to the TradingView live tab for the full CSE history. AI analysis still uses the day range and 52-week levels.'; m.classList.remove('hidden'); }
    startLive();
  } catch (e) {
    $('#symSub').textContent = 'Error';
    const m = $('#chartMsg'); m.textContent = 'Could not load data: ' + e.message + ' — retrying automatically…'; m.classList.remove('hidden');
    getJSON('/api/diag').then(d => { if (!S.candles.length) m.textContent += '  Server feeds: ' + (d.feeds || []).map(f => `${f.name} ${f.ok ? '✓' : '✗'}`).join(' · '); }).catch(() => { });
    setLive(false, 'ERROR');
    S.loadedKey = null;
    // try again automatically (backup feeds may take over)
    const key = `${S.market}|${S.symbol}|${S.tf}`;
    clearTimeout(S.reloadT);
    S.reloadT = setTimeout(() => { if (`${S.market}|${S.symbol}|${S.tf}` === key && !S.candles.length) loadMarket(); }, 25000);
  }
  setView();
  await loadNews();
}
function onTick(c) {
  const cs = S.candles; const last = cs[cs.length - 1];
  const newest = !last || c.time >= last.time;
  if (last && c.time === last.time) cs[cs.length - 1] = c; else if (!last || c.time > last.time) cs.push(c);
  candleS.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  volS.update({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)' });
  S.livePrices[S.market + '|' + S.symbol.toUpperCase()] = c.close;
  updateHeader();
  if (S.selected != null) renderLvlBox();
  if (newest) liveCheck(c.close);
  if (!S.legendHover) tvLegend();
  tvForward(c);
}
function startLive() {
  if (S.market === 'crypto') {
    const sym = (S.meta.symbol || S.symbol).toLowerCase();
    try {
      const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${sym}@kline_${S.tf}`);
      S.ws = ws;
      ws.onopen = () => setLive(true);
      ws.onmessage = ev => { const k = JSON.parse(ev.data).k; if (k) onTick({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }); };
      ws.onerror = () => fallbackPoll();
      ws.onclose = () => { if (S.ws === ws) fallbackPoll(); };
      return;
    } catch { }
  }
  fallbackPoll();
}
function fallbackPoll() {
  clearInterval(S.poll);
  const label = S.market === 'crypto' ? 'LIVE' : 'LIVE';
  setLive(true, label);
  const key = `${S.market}|${S.symbol}|${S.tf}`;
  let fails = 0;
  S.poll = setInterval(async () => {
    if (document.hidden) return;
    let d;
    try { d = await fetchCandles(S.market, S.symbol, S.tf); }
    catch {
      // browser feed failed → try the server feed before calling it a disconnect
      try { d = await getJSON(`/api/candles?market=${S.market}&symbol=${encodeURIComponent(S.symbol)}&tf=${S.tf}&limit=500`); } catch { }
    }
    if (`${S.market}|${S.symbol}|${S.tf}` !== key) return;
    if (!d || !d.candles || !d.candles.length) { if (++fails >= 3) setLive(false, 'RECONNECTING'); return; }
    fails = 0; setLive(true, label);
    // never let a chart/panel drawing problem stop live prices
    d.candles.slice(-3).forEach(c => { try { onTick(c); } catch (e) { console.warn('tick render', e); } });
  }, S.market === 'cse' ? 20000 : S.market === 'forex' && isGold(S.symbol) ? 5000 : 12000);
}
function updateHeader() {
  const cs = S.candles; if (!cs.length) return;
  const last = cs[cs.length - 1].close;
  let ref = S.meta.quote?.prevClose;
  if (!ref) { const dayAgo = last && cs.find(c => c.time >= cs[cs.length - 1].time - 86400); ref = dayAgo ? dayAgo.open : cs[0].open; }
  const ch = last - ref, pct = ref ? ch / ref * 100 : 0;
  $('#lastPrice').textContent = fmt(last);
  const el = $('#lastChg'); el.textContent = `${ch >= 0 ? '+' : ''}${fmt(ch)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  el.className = 'chg ' + (ch >= 0 ? 'up' : 'down');
  document.title = `${fmt(last)} ${S.symbol.toUpperCase()} · Pryme Quant`;
}
function renderIndicators() {
  const I = S.ind; if (!I) return;
  const r = I.rsi != null ? I.rsi.toFixed(1) : '—';
  const trend = I.ema50 && I.ema200 ? (I.ema50 > I.ema200 ? '<b class="up">Up</b>' : '<b class="down">Down</b>') : '<b>—</b>';
  $('#indRow').innerHTML = `
    <div><small>Trend</small>${trend}</div>
    <div><small>RSI 14</small><b class="${I.rsi > 70 ? 'down' : I.rsi < 30 ? 'up' : ''}">${r}</b></div>
    <div><small>MACD</small><b class="${I.macdHist > 0 ? 'up' : 'down'}">${I.macdHist > 0 ? 'Bull' : 'Bear'}</b></div>
    <div><small>ATR</small><b>${fmt(I.atr)}</b></div>
    <div><small>ADX</small><b>${I.adx ? I.adx.adx.toFixed(0) : '—'}</b></div>
    <div><small>Structure</small><b>${esc(I.structure.split(' ')[0])}</b></div>`;
}

/* ---------------- news ---------------- */
async function loadNews() {
  $('#newsList').innerHTML = '<li style="color:var(--dim)">Loading headlines…</li>';
  try {
    const d = await getJSON(`/api/news?market=${S.market}&symbol=${encodeURIComponent(S.symbol)}&name=${encodeURIComponent(S.meta.name || '')}`);
    S.news = d.items || [];
    $('#newsQ').textContent = d.query || '';
    $('#newsList').innerHTML = S.news.length ? S.news.slice(0, 12).map(n => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><small>${esc(n.source || '')} · ${n.date ? new Date(n.date).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</small></li>`).join('') : '<li style="color:var(--dim)">No fresh headlines found.</li>';
  } catch { $('#newsList').innerHTML = '<li style="color:var(--dim)">News unavailable right now.</li>'; }
}

/* ---------------- AI analysis ---------------- */
const SYSTEM_PROMPT = `You are PRYME, an elite multi-asset trading analyst who combines the methods of the world's most consistently profitable discretionary and systematic traders:
- Market structure & price action (HH/HL, LH/LL, break of structure, change of character), supply/demand, support/resistance flips.
- Smart Money Concepts: liquidity pools above equal highs / below equal lows, liquidity sweeps, order blocks, fair value gaps (FVG), premium vs discount zones.
- Classical tools: EMA 20/50/200 trend filter, RSI (momentum + divergence), MACD momentum, ADX trend strength, Bollinger squeeze/expansion, ATR-based volatility stops, Fibonacci 0.5/0.618/0.786 retracements and 1.272/1.618 extensions, candlestick confirmation.
- Multi-timeframe alignment: only trade with the higher-timeframe bias unless there is a clear reversal signal.
- Fundamental/news risk: weigh today's headlines (central banks, CPI/NFP, regulation, earnings, Sri Lanka macro for CSE). High-impact uncertainty = lower confidence, wider stops or wait.
- Strict risk management: every setup has a logical stop beyond a structural level (not inside noise), at least 1:1.5 reward-to-risk to TP1 and 1:2+ to TP2, TP levels placed before the next opposing liquidity/level.
You are honest: no setup is certain. If the chart has no edge, say so, lower confidence, and prefer limit entries at better prices. Never invent prices far from the current market. All prices must be realistic numbers for this instrument.
Return ONLY valid JSON, no markdown.`;

function langLine() {
  return { singlish: 'Write "summary", "newsImpact" and every "reasoning" in simple Singlish (Sinhala language written with English letters, like a Sri Lankan trader friend explains), keeping trading terms in English.', sinhala: 'Write "summary", "newsImpact" and every "reasoning" in Sinhala (සිංහල) script, keeping trading terms in English.', english: 'Write all text in clear simple English.' }[S.settings.lang || 'singlish'];
}

function buildPrompt(I, htf, quant) {
  const p = S.prec, r = v => v == null ? null : +(+v).toFixed(p);
  const cs = S.candles.slice(-80).map(c => [new Date(c.time * 1000).toISOString().slice(5, 16).replace('T', ' '), r(c.open), r(c.high), r(c.low), r(c.close)].join(','));
  const sz = S.settings.active === 'real' ? 'REAL account (real money — be conservative)' : 'demo account';
  const cur = curOf(S.market);
  const bal = ACC()[cur];
  const data = {
    instrument: S.symbol.toUpperCase(), market: S.market, name: S.meta.name, timeframe: S.tf,
    nowColombo: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' }),
    currentPrice: r(I.price), atr14: r(I.atr),
    ema20: r(I.ema20), ema50: r(I.ema50), ema200: r(I.ema200),
    rsi14: I.rsi && +I.rsi.toFixed(1), macdHistogram: I.macdHist && +I.macdHist.toPrecision(4), macdHistRising: I.macdHist > I.macdHistPrev,
    adx: I.adx && { adx: +I.adx.adx.toFixed(1), plusDI: +I.adx.pdi.toFixed(1), minusDI: +I.adx.mdi.toFixed(1) },
    bollinger: I.bb && { upper: r(I.bb.up), mid: r(I.bb.mid), lower: r(I.bb.lo) },
    marketStructure: I.structure, breakOfStructure: I.bos, rsiDivergence: I.divergence || null,
    lastSwingHigh: r(I.swingHi), lastSwingLow: r(I.swingLo), high20: r(I.hi20), low20: r(I.lo20),
    resistances: I.res.map(x => ({ price: r(x.p), touches: x.n })), supports: I.sup.map(x => ({ price: r(x.p), touches: x.n })),
    fibonacci: I.fib && { impulse: I.fib.dir, high: r(I.fib.hi), low: r(I.fib.lo), f50: r(I.fib.f5), f618: r(I.fib.f618), f786: r(I.fib.f786) },
    unfilledFVGs: I.fvg.map(g => ({ type: g.type, top: r(g.top), bottom: r(g.bot) })),
    institutionalLimitZones: (I.zones || []).slice(0, 6).map(z => ({ side: z.side, from: r(z.lo), to: r(z.hi), entry: r(z.entry), confluence: z.tags, score: z.score, liquiditySweep: z.sweep })),
    keyLevels: I.keys && { prevDayHigh: r(I.keys.pdh), prevDayLow: r(I.keys.pdl), sessionVWAP: r(I.keys.vwap), volumePOC: r(I.keys.poc), rangeEquilibrium: r(I.keys.eq), premiumOrDiscount: I.price > I.keys.eq ? 'premium' : 'discount', equalHighs: (I.keys.eqh || []).map(r), equalLows: (I.keys.eql || []).map(r) },
    lastCandlePatterns: I.patterns, volumeVsAvg: I.volRatio && +I.volRatio.toFixed(2),
    higherTimeframe: htf, secondHigherTimeframe: S.lastHtf2 || undefined, cseQuote: S.meta.quote || undefined,
    quantEngine: { score: quant.score, bias: quant.bias, candidateSetups: quant.setups.map(s => ({ name: s.name, direction: s.direction, entry: r(s.entry), stopLoss: r(s.stopLoss), tp1: r(s.tp1), tp2: r(s.tp2), tp3: r(s.tp3) })) },
    todaysHeadlines: S.news.slice(0, 8).map(n => n.title),
    recentSignalResultsOnThisSymbol: perfFor(S.symbol.toUpperCase()),
    fullAnalysis29Methods: S.deep ? S.deep.forAI : undefined,
    upcomingNews: newsNear(S.market, S.symbol, 6 * 60).map(e => `${e.cur} ${e.title} (${e.impact}) in ${Math.round((e.t - Date.now()) / 60000)} min`),
    account: { wallet: sz, balance: bal, currency: cur, riskPerTradePct: S.settings.riskPct }
  };
  return `Analyse this ${S.market.toUpperCase()} chart and give the best 3 to 4 trade setups on the ${S.tf} timeframe.

DATA (JSON):
${JSON.stringify(data)}

LAST 80 CANDLES (time UTC, open, high, low, close):
${cs.join('\n')}

Rules:
- Give 1 to 4 setups. Only include setups you would really take; if the market has no clean edge (choppy, mid-range, news risk), give 1–2 conservative limit setups at strong levels and say so in the summary. Never invent counter-trend scalps just to fill the list.
- Each setup: direction "long" or "short", entry, stopLoss, tp1, tp2, tp3 as plain numbers with ${p} decimals.
- For long: stopLoss < entry < tp1 < tp2 < tp3. For short: stopLoss > entry > tp1 > tp2 > tp3.
- Entries must be within ~3 ATR of current price. Use the candidate setups from the quant engine as a starting point but improve them with structure, liquidity and news.
- confidence = honest probability (0-100) that TP1 is hit before SL.
- WIN-RATE FIRST: quality over quantity. Rank the best setup first. Prefer entries at a level where liquidity was already swept or price is in discount (longs) / premium (shorts), aligned with the higher timeframe. Counter-trend ideas must get confidence below 50.
- LIMIT ENTRIES LIKE INSTITUTIONAL TRADERS: prefer BUY/SELL LIMIT orders inside the institutionalLimitZones (order block, fair value gap 50%, OTE 0.618–0.786, liquidity sweep reclaim, previous-day high/low, VWAP, volume POC). Longs only in discount, shorts only in premium of the dealing range. Entry at the zone's proximal half, stop beyond the zone AND the swing that formed it, TP1 at the first opposing liquidity, TP2 at the next liquidity pool (equal highs/lows, PDH/PDL).
- Use fullAnalysis29Methods: only give TRADE-quality setups in the direction most methods agree on; if they disagree, say the market has no clear edge and give at most 1 conservative limit setup.
- Put stops beyond the liquidity (beyond the swing + at least 0.3 ATR buffer) and NEVER closer than 1.3 × ATR from entry — tight stops inside the noise are the #1 cause of losses. Never at an obvious round number. TP1 about 1R (before the nearest opposing level) so it gets hit often; TP2 at least 2R.
- ${S.settings.pro.mode === 'highwin' ? 'HIGH WIN-RATE MODE: only setups where BOTH higher timeframes agree, entered at a key level (limit) or after a confirmation candle close (market). TP1 about 0.7R. Fewer trades is fine — 0 good trades is better than 3 bad ones (return 1 conservative limit setup if nothing qualifies).' : ''}
- Trend-following only when the higher timeframe agrees. If ADX < 18 (choppy), prefer limit entries at range extremes only. Avoid entries 45 minutes around high-impact news listed in upcomingNews.
- Learn from recentSignalResultsOnThisSymbol: if recent signals were stopped out, adjust (wait for confirmation, wider/safer stop, or trade with the HTF trend only).
- ${langLine()}

Reply with JSON exactly in this shape:
{"bias":"BULLISH|BEARISH|NEUTRAL","score":-100..100,"summary":"2-4 sentences","newsImpact":"1-2 sentences on how today's news affects this","setups":[{"name":"short title","direction":"long|short","entry":0,"stopLoss":0,"tp1":0,"tp2":0,"tp3":0,"confidence":0,"reasoning":"why this level: structure, confluence, invalidation"}],"keyLevels":{"support":[0],"resistance":[0]},"invalidation":"what would cancel the bias"}`;
}
function parseAIJson(t) {
  if (!t) throw new Error('Empty AI reply');
  t = t.replace(/```json|```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI reply was not JSON');
  return JSON.parse(t.slice(a, b + 1));
}

const HTF2 = { '1m': '1h', '5m': '4h', '15m': '1d', '30m': '1d', '1h': '1d', '4h': null, '1d': null };
async function htfInfo(h = HTF[S.tf]) {
  if (!h) return null;
  try {
    const d = await fetchCandles(S.market, S.symbol, h, 400);
    if (!d.candles || d.candles.length < 50) return null;
    const I = analyseIndicators(d.candles);
    return { timeframe: h, bias: I.score > 15 ? 'bullish' : I.score < -15 ? 'bearish' : 'neutral', score: I.score, structure: I.structure, ema50: I.ema50, ema200: I.ema200, rsi: I.rsi && +I.rsi.toFixed(1), nearestRes: I.res[0]?.p, nearestSup: I.sup[0]?.p };
  } catch { return null; }
}

async function runAnalysis() {
  if (!S.candles.length || S.loadedKey !== `${S.market}|${S.symbol.toUpperCase()}`) { toast('Chart data not loaded for this symbol yet — wait a moment'); return; }
  const btn = $('#btnAnalyse'); btn.classList.add('busy'); btn.querySelector('.btn-label').textContent = 'Analysing…';
  const st = $('#aiStatus'); st.className = 'ai-status'; st.textContent = 'Reading structure, indicators, higher timeframe and news…';
  try {
    S.ind = analyseIndicators(S.candles);
    const [htf, htf2] = await Promise.all([htfInfo(HTF[S.tf]), htfInfo(HTF2[S.tf])]);
    S.lastHtf2 = htf2;
    st.textContent = 'Running the full 29-method analysis…';
    try { await loadCalendar(); S.deep = await deepAnalysis(htf, htf2); } catch (e) { console.warn('deep analysis failed', e); S.deep = null; }
    const quant = quantSetups(S.ind, htf?.bias);
    const keys = S.settings.keys.filter(k => k.enabled !== false && k.key);
    let result = null, by = 'Pryme quant engine (add an AI key for full AI analysis)';
    if (keys.length) {
      st.textContent = 'Asking AI (' + keys.map(k => PROVIDERS[k.provider]?.label).join(' → ') + ')…';
      try {
        const res = await getJSON('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys, system: SYSTEM_PROMPT, prompt: buildPrompt(S.ind, htf, quant) }) });
        result = parseAIJson(res.text);
        by = `${PROVIDERS[res.provider]?.label || res.provider} · ${res.model}` + (res.errors?.length ? ` (fallback after ${res.errors.length} failed)` : '');
      } catch (e) {
        st.className = 'ai-status err';
        st.textContent = 'AI failed (' + e.message + ') — showing quant engine setups instead.';
      }
    }
    let setups = result ? cleanSetups(result.setups, S.ind) : [];
    if (setups.length < 1) {
      const extra = quant.setups.filter(q => !setups.some(s => Math.abs(s.entry - q.entry) < S.ind.atr * 0.3));
      setups = setups.concat(extra).slice(0, 4);
    }
    setups = setups.slice(0, 4);
    S.setups = setups;
    S.analysis = {
      bias: (result?.bias || quant.bias).toUpperCase(), score: isFinite(+result?.score) ? +result.score : quant.score,
      summary: result?.summary || autoSummary(S.ind, htf, quant), newsImpact: result?.newsImpact || '',
      keyLevels: result?.keyLevels, invalidation: result?.invalidation, by, htf, htf2
    };
    const RANK = { 'A+': 4, A: 3, B: 2, C: 1 };
    await loadCalendar();
    S.setups.forEach(s => { proAdjust(s); s.grade = gradeOf(s, S.analysis); });
    S.setups.sort((a, b) => ((b.ok ? 1 : 0) - (a.ok ? 1 : 0)) || (RANK[b.grade] - RANK[a.grade]) || (b.confidence - a.confidence));
    newSignalBatch();
    renderResult(S.analysis);
    try { renderDeep(); } catch { }
    if (setups.length) drawSetupLines(0);
    if (!st.classList.contains('err')) st.textContent = `Done · ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo' })} Colombo time`;
  } catch (e) {
    st.className = 'ai-status err'; st.textContent = 'Analysis error: ' + e.message;
  } finally {
    btn.classList.remove('busy'); btn.querySelector('.btn-label').textContent = 'Analyse with AI';
  }
}
function gradeOf(s, A, ctx = {}) {
  // old score (kept as one input) + the pro checklist
  let pts = 0;
  const rr = Math.abs(s.tp2 - s.entry) / Math.abs(s.entry - s.stopLoss);
  if (rr >= 2) pts += 2; else if (rr >= 1.5) pts += 1;
  if (s.confidence >= 70) pts += 2; else if (s.confidence >= 60) pts += 1;
  const htf = A.htf?.bias, d = s.direction;
  if (htf && ((htf === 'bullish' && d === 'long') || (htf === 'bearish' && d === 'short'))) pts += 2;
  else if (htf && htf !== 'neutral') pts -= 2;
  if ((A.bias.includes('BULL') && d === 'long') || (A.bias.includes('BEAR') && d === 'short')) pts += 1;
  s.checks = proChecks(s, A, ctx);
  const failed = s.checks.filter(c => !c.ok);
  const hardFail = failed.some(c => c.hard);
  const P = S.settings.pro;
  if (!P.enabled) { s.ok = pts >= 4; return pts >= 6 ? 'A+' : pts >= 4 ? 'A' : pts >= 2 ? 'B' : 'C'; }
  if (P.mode === 'highwin') {
    // high win-rate: every single check must pass
    s.ok = failed.length === 0 && pts >= 4;
    if (s.ok) return pts >= 6 ? 'A+' : 'A';
    return hardFail || failed.length >= 3 ? 'C' : 'B';
  }
  s.ok = !hardFail && failed.length <= 1 && pts >= 3;
  if (s.ok) return failed.length === 0 && pts >= 5 ? 'A+' : 'A';
  return hardFail || failed.length >= 3 ? 'C' : 'B';
}
function perfFor(sym) {
  const list = S.sigStats.filter(x => x.symbol === sym).slice(-10);
  return { wins: list.filter(x => x.win).length, losses: list.filter(x => !x.win).length, last: list.slice(-5).map(x => ({ dir: x.dir, entryType: x.type, result: x.win ? 'TP hit' : 'SL hit', setup: x.name })) };
}
function autoSummary(I, htf, q) {
  return `${S.symbol.toUpperCase()} ${S.tf}: structure ${I.structure}, price ${I.price > (I.ema50 || 0) ? 'above' : 'below'} EMA50, RSI ${I.rsi?.toFixed(0)}. ${htf ? `Higher timeframe (${htf.timeframe}) is ${htf.bias}.` : ''} Quant score ${q.score}. ${I.divergence ? I.divergence + '.' : ''} ${I.patterns.join(', ')}`;
}

function renderResult(A) {
  if (!A) { $('#resultEmpty').classList.remove('hidden'); $('#resultBody').classList.add('hidden'); return; }
  $('#resultEmpty').classList.add('hidden'); $('#resultBody').classList.remove('hidden');
  const sc = Math.max(-100, Math.min(100, Math.round(A.score)));
  const fg = $('#gaugeFg'); fg.style.strokeDashoffset = 157 - 157 * (sc + 100) / 200;
  fg.style.stroke = sc > 12 ? 'var(--long)' : sc < -12 ? 'var(--short)' : 'var(--gold)';
  $('#gaugeVal').textContent = (sc > 0 ? '+' : '') + sc;
  const bl = $('#biasLabel'); bl.textContent = A.bias; bl.className = 'bias ' + (A.bias.includes('BULL') ? 'up' : A.bias.includes('BEAR') ? 'down' : '');
  $('#aiBy').textContent = A.by + (A.htf ? ` · HTF ${A.htf.timeframe}: ${A.htf.bias}` : '');
  $('#summaryText').textContent = A.summary;
  $('#newsImpact').textContent = A.newsImpact ? '📰 ' + A.newsImpact : '';
  const okN = S.setups.filter(s => s.ok).length, guard = riskGuard();
  $('#proBanner').className = 'pro-banner ' + (guard.block ? 'stop' : okN ? 'go' : 'wait');
  $('#proBanner').innerHTML = guard.block ? `⛔ <b>Trading paused</b> — ${esc(guard.why)}`
    : okN ? `✓ <b>${okN} of ${S.setups.length}</b> setup${okN > 1 ? 's' : ''} passed the Pro checklist. Trade only the ones marked TRADE.`
    : `⏸ <b>No high-probability trade right now.</b> Best move: wait. Pryme keeps watching and gives the next setup.`;
  const p = S.ind.price, a = S.ind.atr;
  $('#setups').innerHTML = S.setups.map((s, i) => {
    const z = sizing(s, S.market, S.symbol);
    const rr = Math.abs(s.tp2 - s.entry) / Math.abs(s.entry - s.stopLoss);
    const type = orderTypeOf(s, p, a);
    const size = z.lots != null ? `${z.lots.toFixed(z.lots < 0.1 ? 3 : 2)} lots` : S.market === 'crypto' ? `${z.units.toPrecision(4)} ${S.symbol.toUpperCase().replace(/USDT|USDC$/, '')}` : `${Math.floor(z.units)} shares`;
    return `<div class="setup" data-i="${i}">
      <div class="setup-top"><span class="tag ${s.direction}">${s.direction === 'long' ? 'BUY' : 'SELL'}</span><span class="tag type">${type}</span><span class="setup-name">#${i + 1} ${esc(s.name)}</span><span class="grade g${(s.grade || 'C').replace('+', 'p')}">${s.grade || ''}</span><span class="conf">${s.confidence}%</span></div>
      <div class="lv">
        <div class="en"><small>ENTRY</small><b>${fmt(s.entry)}</b></div>
        <div class="sl"><small>STOP LOSS</small><b>${fmt(s.stopLoss)}</b></div>
        <div class="tp"><small>TP1</small><b>${fmt(s.tp1)}</b></div>
        <div class="tp"><small>TP2</small><b>${fmt(s.tp2)}</b></div>
        <div class="tp"><small>TP3</small><b>${fmt(s.tp3)}</b></div>
        <div><small>R:R (TP2)</small><b>1:${rr.toFixed(1)}</b></div>
      </div>
      <div class="meta"><span>Size <b>${size}</b></span><span>Risk <b class="down">${money(z.riskAmt, z.cur)}</b></span><span>TP1 <b class="up">+${money(z.p1, z.cur)}</b></span><span>TP2 <b class="up">+${money(z.p2, z.cur)}</b></span>${z.lev > 1.05 ? `<span>Leverage ≈ <b>${z.lev.toFixed(1)}x</b></span>` : ''}</div>
      ${z.note ? `<div class="meta" style="margin-top:4px">${esc(z.note)}</div>` : ''}
      ${s.checks ? `<div class="checks"><span class="verdict-tag ${s.ok ? 'ok' : 'watch'}">${s.ok ? '✓ TRADE' : '⏸ WATCH ONLY'}</span>${s.checks.map(c => `<span class="ck ${c.ok ? 'ok' : 'no'}" title="${esc(c.tip || '')}">${c.ok ? '✓' : '✗'} ${esc(c.label)}</span>`).join('')}</div>` : ''}
      <p class="why">${esc(s.reasoning)}</p>
      <div class="setup-act"><button data-show="${i}">Show</button><button class="go ${s.ok === false ? 'dim' : ''}" data-trade="${i}" data-acc="demo">Take on Demo</button><button class="real ${s.ok === false ? 'dim' : ''}" data-trade="${i}" data-acc="real">Took on Real</button></div>
    </div>`;
  }).join('');
  const kl = A.keyLevels;
  $('#keyLevels').innerHTML = (kl ? `Support: ${(kl.support || []).map(x => fmt(x)).join(' · ') || '—'}<br>Resistance: ${(kl.resistance || []).map(x => fmt(x)).join(' · ') || '—'}<br>` : '') + (A.invalidation ? `Invalidation: ${esc(A.invalidation)}` : '');
}


/* ============================================================
   ACCOUNTS (Demo + Real), LIVE SIGNALS, AUTO NEXT SETUP
   ============================================================ */
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const nowSec = () => Math.floor(Date.now() / 1000);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const colomboTime = t => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });

function addLog(msg) {
  S.log.unshift({ t: Date.now(), msg }); S.log = S.log.slice(0, 50);
  store.set('pa_log', S.log); renderLog();
}
function renderLog() {
  $('#autoLog').innerHTML = S.log.length ? S.log.slice(0, 14).map(l => `<li><span>${colomboTime(l.t)}</span>${esc(l.msg)}</li>`).join('') : '<li class="dim">Signal and auto events will appear here.</li>';
}
function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(0.12, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
    o.start(); o.stop(ac.currentTime + 0.4);
  } catch { }
}

const startBar = ms => Math.floor(ms / 60000) * 60;
// small allowance for feed/broker price differences (spread). Applied equally to TP and SL.
const tolFor = (market, p) => market === 'forex' ? p * 0.00012 : market === 'crypto' ? p * 0.0002 : 0; // the 1m bar the item was created in
// migrate items from older versions (they used wall-clock checks and could skip candles)
[...S.signals, ...S.accounts.demo.positions, ...S.accounts.real.positions].forEach(x => {
  if ('lastCheck' in x) { delete x.lastCheck; x.lastBar = null; }
});

/* ---------- live signals ---------- */
function latestBatch(market, symbol) {
  return S.signals.filter(g => g.market === market && g.symbol === symbol).reduce((m, g) => Math.max(m, g.batch), 0);
}
function newSignalBatch() {
  const sym = S.symbol.toUpperCase(), price = S.ind.price, a = S.ind.atr;
  S.batch++;
  S.signals.forEach(g => { if (g.market === S.market && g.symbol === sym && g.status === 'waiting') g.status = 'replaced'; });
  S.setups.forEach((s, i) => {
    const type = orderTypeOf(s, price, a), isM = type.startsWith('MARKET');
    const g = {
      id: uid(), batch: S.batch, idx: i, market: S.market, symbol: sym, tf: S.tf, dir: s.direction, type, name: s.name,
      conf: s.confidence, grade: s.grade, ok: s.ok, entry: isM ? price : s.entry, sl: s.stopLoss, sl0: s.stopLoss, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
      prec: S.prec, status: isM ? 'active' : 'waiting', created: Date.now(), lastBar: startBar(Date.now()) + 60
    };
    S.signals.push(g); s.sigId = g.id;
  });
  const keep = g => ['waiting', 'active', 'tp1'].includes(g.status) || Date.now() - g.created < 2 * 86400000;
  S.signals = S.signals.filter(keep).slice(-60);
  saveSignals(); renderSignals();
  addLog(`${sym} ${S.tf}: ${S.setups.length} new setups (${ACC_LABEL[S.settings.active]} balance ${money(ACC()[curOf(S.market)], curOf(S.market))}).`);
  if (S.settings.auto.autoTake === 'demo') autoTakeBest();
}
function recordStat(g, win) {
  S.sigStats.push({ symbol: g.symbol, market: g.market, dir: g.dir, type: g.type, name: g.name, grade: g.grade, ok: g.ok, win, t: Date.now() });
}
function processSignal(g, candles, live = false) {
  const sg = g.dir === 'long' ? 1 : -1;
  const events = [];
  // candle-based: re-check the still-forming candle, never skip delayed/missed candles. live = a single real-time tick.
  for (const c of (live ? candles : candles.filter(c => c.time >= (g.lastBar ?? startBar(g.created))))) {
    const tol = tolFor(g.market, c.close);
    if (g.status === 'waiting') {
      const fill = (g.type === 'BUY LIMIT' && c.low <= g.entry) || (g.type === 'BUY STOP' && c.high >= g.entry) ||
        (g.type === 'SELL LIMIT' && c.high >= g.entry) || (g.type === 'SELL STOP' && c.low <= g.entry);
      if (!fill) continue;
      g.status = 'active'; g.triggered = Date.now(); events.push('active');
    }
    const hit = lvl => sg > 0 ? c.high >= lvl - tol : c.low <= lvl + tol;
    const hitSL = sg > 0 ? c.low <= g.sl + tol : c.high >= g.sl - tol;
    let justHit = false;
    if (g.status === 'active') {
      if (hitSL) { g.status = 'sl'; recordStat(g, false); events.push('sl'); break; }
      if (hit(g.tp1)) { g.status = 'tp1'; g.sl = g.entry; g.tp1At = c.time; recordStat(g, true); events.push('tp1'); justHit = true; }
    }
    if (g.status === 'tp1') {
      if (hit(g.tp2)) { g.status = 'tp2'; events.push('tp2'); break; }
      if (!justHit && (live || c.time > (g.tp1At ?? 0)) && (sg > 0 ? c.low <= g.sl - tol : c.high >= g.sl + tol)) { g.status = 'be'; events.push('be'); break; }
    }
  }
  if (candles.length && !live) g.lastBar = Math.max(g.lastBar ?? 0, candles[candles.length - 1].time);
  if (g.status === 'waiting' && Date.now() - g.created > S.settings.auto.expiryBars * (TF_SEC[g.tf] || 900) * 1000) { g.status = 'expired'; events.push('expired'); }
  events.forEach(e => onSignalEvent(g, e));
}
function onSignalEvent(g, e) {
  const L = { active: 'entry triggered', tp1: 'TP1 HIT ✓', tp2: 'TP2 HIT ✓✓', sl: 'SL hit ✗', be: 'closed at break-even', expired: 'expired (entry never reached)' }[e];
  addLog(`${g.symbol} signal #${g.idx + 1} ${g.dir === 'long' ? 'BUY' : 'SELL'} ${L}.`);
  if (['tp1', 'tp2', 'sl'].includes(e)) notify(`Pryme: ${g.symbol} ${L}`, `${g.name}`);
  const A = S.settings.auto;
  let fire = (e === 'tp1' && A.trigger === 'tp1') || ((e === 'tp2' || e === 'be') && A.trigger === 'tp2') || (e === 'sl' && A.onSL);
  if (e === 'expired') {
    // only when nothing else from this batch is still waiting/running
    fire = !S.signals.some(x => x.batch === g.batch && ['waiting', 'active', 'tp1'].includes(x.status));
  }
  if (fire) requestNext(g.batch, g.market, g.symbol, g.tf, `${g.symbol} #${g.idx + 1} ${L}`);
  renderSignals();
}
function requestNext(batch, market, symbol, tf, why) {
  if (!S.settings.auto.enabled) return;
  const g = riskGuard(symbol);
  if (g.block) {
    addLog(`${why} → next setup paused: ${g.why}`);
    clearTimeout(S.autoRetry['guard' + symbol]);
    if (g.until) S.autoRetry['guard' + symbol] = setTimeout(() => requestNext(latestBatch(market, symbol), market, symbol, tf, `${symbol} pause ended`), Math.max(60000, g.until - Date.now()));
    return;
  }
  if (batch !== latestBatch(market, symbol) || S.batchDone[batch]) return;
  S.batchDone[batch] = true;
  addLog(`${why} → creating next setup…`);
  if (!S.autoQueue.some(j => j.market === market && j.symbol === symbol)) S.autoQueue.push({ market, symbol, tf });
  setTimeout(runAutoCycle, 400);
}
async function switchTo(market, symbol, tf) {
  S.tf = tf; store.set('pa_tf', tf);
  $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf));
  store.set('pa_sym_' + market, symbol);
  await setMarket(market, symbol);
}
async function runAutoCycle() {
  if (S.autoBusy) return;
  const job = S.autoQueue.shift(); if (!job) return;
  S.autoBusy = true;
  try {
    if (job.market !== S.market || job.symbol !== S.symbol.toUpperCase() || job.tf !== S.tf) await switchTo(job.market, job.symbol, job.tf);
    else await loadMarket();
    if (!S.candles.length) throw new Error('no chart data');
    await runAnalysis(); // creates the new signal batch
  } catch (e) {
    addLog(`${job.symbol}: next setup failed (${e.message}) — retrying in 2 min.`);
    clearTimeout(S.autoRetry[job.symbol]);
    S.autoRetry[job.symbol] = setTimeout(() => { S.autoQueue.push(job); runAutoCycle(); }, 120000);
  } finally {
    S.autoBusy = false;
    if (S.autoQueue.length) setTimeout(runAutoCycle, 1500);
  }
}
function autoTakeBest() {
  const A = S.settings.auto, acc = S.accounts.demo;
  const open = acc.positions.filter(p => p.auto && p.status !== 'closed');
  const sym = S.symbol.toUpperCase();
  const stale = acc.positions.filter(p => p.auto && p.status === 'pending' && p.symbol === sym);
  if (stale.length) acc.positions = acc.positions.filter(p => !stale.includes(p));
  if (open.length - stale.length >= A.maxOpen) { addLog(`Auto-take skipped: ${A.maxOpen} auto demo trades already open.`); return; }
  if (riskGuard().block) { addLog(`Auto-take skipped: ${riskGuard().why}`); return; }
  const i = S.setups.findIndex(s => s.ok && ['A+', 'A'].includes(s.grade) && s.confidence >= A.minConf);
  if (i < 0) { addLog(`${sym}: no A-grade setup ≥ ${A.minConf}% — auto-take skipped (waiting for a cleaner one).`); return; }
  const s = S.setups[i];
  const z = sizingFor('demo', s, S.market, S.symbol);
  const units = (S.market === 'stock' || S.market === 'cse') ? Math.floor(z.units) : +z.units.toPrecision(5);
  if (!(units > 0)) { addLog('Demo balance too small for auto-take.'); return; }
  const pos = createPosition('demo', s, { entry: s.entry, sl: s.stopLoss, tp1: s.tp1, tp2: s.tp2, units, auto: true });
  addLog(`AUTO demo ${pos.type} #${i + 1} ${sym} @ ${fmt(pos.entry)} · SL ${fmt(s.stopLoss)} · TP ${fmt(s.tp1)}/${fmt(s.tp2)} · risk ${money(z.riskAmt, z.cur)}`);
  renderAccounts();
}
function renderSignals() {
  const st = S.sigStats, w = st.filter(x => x.win).length;
  const symSt = st.filter(x => x.symbol === S.symbol.toUpperCase()), sw = symSt.filter(x => x.win).length;
  const okSt = st.filter(x => x.ok), ow = okSt.filter(x => x.win).length;
  $('#sigRecord').textContent = st.length ? `All ${(w / st.length * 100).toFixed(0)}% (${st.length})${okSt.length ? ` · TRADE-only ${(ow / okSt.length * 100).toFixed(0)}% (${okSt.length})` : ''}${symSt.length ? ` · this ${(sw / symSt.length * 100).toFixed(0)}%` : ''}` : 'no results yet';
  const sym = S.symbol.toUpperCase(), lb = latestBatch(S.market, sym);
  const list = S.signals.filter(g => (g.market === S.market && g.symbol === sym && g.batch === lb) || ['active', 'tp1'].includes(g.status))
    .sort((a, b) => b.batch - a.batch || a.idx - b.idx).slice(0, 10);
  const label = { waiting: 'WAITING', active: 'IN TRADE', tp1: 'TP1 ✓', tp2: 'TP2 ✓✓', sl: 'SL ✗', be: 'BE', expired: 'EXPIRED', replaced: 'REPLACED' };
  $('#sigList').innerHTML = list.length ? list.map(g => {
    const px = S.livePrices[g.market + '|' + g.symbol];
    const dist = px != null ? ` · now ${fmt(px, g.prec)}` : '';
    return `<li><span class="tag ${g.dir}">${g.dir === 'long' ? 'BUY' : 'SELL'}</span><span class="s-main">${esc(g.symbol)} #${g.idx + 1} ${g.grade ? `<span class="grade g${g.grade.replace('+', 'p')}">${g.grade}</span>` : ''}</span><span class="st ${g.status}">${label[g.status]}</span><span class="s-sub">${g.type} ${fmt(g.entry, g.prec)} · SL ${fmt(g.sl0, g.prec)} · TP ${fmt(g.tp1, g.prec)}/${fmt(g.tp2, g.prec)}${dist}</span>${g.status === 'active' ? `<span class="s-acts"><button class="mk ok" data-smark="tp1" data-id="${g.id}">TP1 hit</button><button class="mk bad" data-smark="sl" data-id="${g.id}">SL hit</button></span>` : g.status === 'tp1' ? `<span class="s-acts"><button class="mk ok" data-smark="tp2" data-id="${g.id}">TP2 hit</button><button class="mk" data-smark="be" data-id="${g.id}">BE</button></span>` : ''}</li>`;
  }).join('') : '<li class="dim">Run an analysis — its setups are tracked here live. When one hits TP, the next setup is created automatically.</li>';
}

/* ---------- positions (demo + real) ---------- */
function sizingFor(accKey, s, market, sym) {
  const prev = S.settings.active; S.settings.active = accKey;
  try { return sizing(s, market, sym); } finally { S.settings.active = prev; }
}
let pendingTrade = null;
function openTradeModal(i, accKey) {
  const s = S.setups[i]; if (!s) return;
  const guard = riskGuard();
  const fails = (s.checks || []).filter(c => !c.ok).map(c => c.label);
  pendingTrade = { s, i, warn: [guard.block ? '⛔ ' + guard.why : '', s.ok === false && fails.length ? '⏸ Watch-only setup — not passed: ' + fails.join(', ') : ''].filter(Boolean).join('<br>') };
  $('#tmAcc').value = accKey || S.settings.active;
  $('#tmEntry').value = +s.entry.toFixed(S.prec); $('#tmSL').value = +s.stopLoss.toFixed(S.prec);
  $('#tmTP1').value = +s.tp1.toFixed(S.prec); $('#tmTP2').value = +s.tp2.toFixed(S.prec);
  fillUnits(); $('#tmType').value = 'auto';
  $('#tradeModal').classList.remove('hidden');
}
function fillUnits() {
  const s = pendingTrade.s, z = sizingFor($('#tmAcc').value, s, S.market, S.symbol);
  $('#tmUnits').value = S.market === 'crypto' || S.market === 'forex' ? +z.units.toFixed(6) : Math.floor(z.units);
  updateTmInfo();
}
function updateTmInfo() {
  if (!pendingTrade) return;
  const acc = $('#tmAcc').value;
  const entry = +$('#tmEntry').value, sl = +$('#tmSL').value, units = +$('#tmUnits').value, tp1 = +$('#tmTP1').value, tp2 = +$('#tmTP2').value;
  const f = quoteFactor(S.market, S.symbol, entry), cur = curOf(S.market), cs = contractSize(S.market, S.symbol);
  $('#tmTitle').textContent = `${ACC_LABEL[acc]} ${pendingTrade.s.direction === 'long' ? 'BUY' : 'SELL'} · ${S.symbol.toUpperCase()}`;
  $('#tmConfirm').textContent = acc === 'real' ? 'Track on Real' : 'Place on Demo';
  const W = pendingTrade.warn ? `<div class="tm-warn">${pendingTrade.warn}</div>` : '';
  $('#tmInfo').innerHTML = W + `${ACC_LABEL[acc]} balance: <b>${money(S.accounts[acc][cur], cur)}</b><br>Risk if SL hits: <b class="down">${money(Math.abs(entry - sl) * units * f, cur)}</b><br>Profit TP1 (half) + TP2 (half): <b class="up">${money((Math.abs(tp1 - entry) + Math.abs(tp2 - entry)) * units / 2 * f, cur)}</b>${cs > 1 ? `<br>= ${(units / cs).toFixed(2)} lots` : ''}${acc === 'real' ? '<br><span style="color:var(--gold)">Place this trade at your broker with the same levels. Pryme tracks it live and updates your Real balance estimate.</span>' : ''}`;
}
function placeTrade() {
  const { s } = pendingTrade, acc = $('#tmAcc').value;
  const entry = +$('#tmEntry').value, sl = +$('#tmSL').value, tp1 = +$('#tmTP1').value, tp2 = +$('#tmTP2').value, units = +$('#tmUnits').value;
  const sg = s.direction === 'long' ? 1 : -1;
  if (!(units > 0) || (sl - entry) * sg >= 0 || (tp1 - entry) * sg <= 0 || (tp2 - entry) * sg <= 0) { toast('Check levels: SL and TPs must be on the correct side of entry'); return; }
  const pos = createPosition(acc, s, { entry, sl, tp1, tp2, units, market: $('#tmType').value === 'market' });
  $('#tradeModal').classList.add('hidden');
  addLog(`${ACC_LABEL[acc]}: ${pos.type} ${pos.symbol} @ ${fmt(pos.entry)} · SL ${fmt(sl)} · TP ${fmt(tp1)}/${fmt(tp2)}`);
  toast(`${ACC_LABEL[acc]}: ${pos.status === 'open' ? 'trade opened' : pos.type + ' placed'}`);
  setAcctView(acc);
  document.getElementById('acctSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function createPosition(accKey, s, { entry, sl, tp1, tp2, units, market = false, auto = false }) {
  const price = S.candles[S.candles.length - 1].close, a = S.ind.atr;
  let type = orderTypeOf({ ...s, entry }, price, a);
  if (market) type = s.direction === 'long' ? 'MARKET BUY' : 'MARKET SELL';
  const isM = type.startsWith('MARKET');
  const pos = {
    id: uid(), acc: accKey, market: S.market, symbol: S.symbol.toUpperCase(), tf: S.tf, dir: s.direction, type,
    code: nextTradeCode(), tp3: s.tp3,
    entry: isM ? price : entry, sl, sl0: sl, tp1, tp2, units, remaining: units, cur: curOf(S.market), pip: pipSizeFor(S.market, S.symbol, entry),
    factor: quoteFactor(S.market, S.symbol, entry), status: isM ? 'open' : 'pending', created: Date.now(), opened: isM ? Date.now() : null,
    realized: 0, tp1Hit: false, lastBar: startBar(Date.now()) + 60, prec: S.prec, name: s.name, grade: s.grade, ok: s.ok, auto, batch: S.batch, sigId: s.sigId
  };
  S.accounts[accKey].positions.push(pos); saveAccounts();
  if (isM) chartEvent(pos, 'Entry', 'entry');
  if (S.selected != null) drawSetupLines(S.selected);
  drawPositions(); S.lvlHidden = false; renderLvlBox();
  return pos;
}
function closePart(pos, price, units, reason) {
  const acc = S.accounts[pos.acc];
  const pnl = (price - pos.entry) * (pos.dir === 'long' ? 1 : -1) * units * pos.factor;
  pos.remaining -= units; pos.realized += pnl;
  acc[pos.cur] += pnl;
  if (pos.remaining <= 1e-12) {
    pos.status = 'closed';
    acc.history.unshift({ ...pos, exit: price, closed: Date.now(), reason, pnl: pos.realized });
    acc.positions = acc.positions.filter(p => p.id !== pos.id);
  }
  addLog(`${ACC_LABEL[pos.acc]} ${pos.symbol} ${reason}: ${pnl >= 0 ? '+' : ''}${money(pnl, pos.cur)} → balance ${money(acc[pos.cur], pos.cur)}${pos.acc === 'real' ? ' (check with broker)' : ''}`);
  toast(`${ACC_LABEL[pos.acc]} ${pos.symbol} ${reason}: ${pnl >= 0 ? '+' : ''}${money(pnl, pos.cur)}`, 4000);
  const kind = reason.startsWith('TP2') ? 'tp2' : reason.startsWith('TP1') ? 'tp1' : reason.startsWith('Stop') ? 'sl' : reason.startsWith('Break') ? 'be' : 'manual';
  chartEvent(pos, { tp1: 'TP1 ✓', tp2: 'TP2 ✓', sl: 'SL ✗', be: 'BE', manual: 'Closed' }[kind], { tp1: 'tp', tp2: 'tp', sl: 'sl', be: 'be', manual: 'be' }[kind]);
  drawPositions();
  if (['tp1', 'tp2', 'sl'].includes(kind)) notify(`Pryme ${ACC_LABEL[pos.acc]}: ${pos.symbol} ${reason}`, `${pnl >= 0 ? '+' : ''}${money(pnl, pos.cur)}`);
  const A = S.settings.auto;
  if (!pos.manual && ((kind === 'tp1' && A.trigger === 'tp1') || ((kind === 'tp2' || kind === 'be') && A.trigger === 'tp2') || (kind === 'sl' && A.onSL)))
    requestNext(pos.batch, pos.market, pos.symbol, pos.tf, `${ACC_LABEL[pos.acc]} ${pos.symbol} ${reason}`);
}
function processPosition(pos, candles, live = false) {
  const sg = pos.dir === 'long' ? 1 : -1;
  for (const c of (live ? candles : candles.filter(c => c.time >= (pos.lastBar ?? startBar(pos.created))))) {
    if (pos.status === 'pending') {
      const fill = (pos.type === 'BUY LIMIT' && c.low <= pos.entry) || (pos.type === 'BUY STOP' && c.high >= pos.entry) ||
        (pos.type === 'SELL LIMIT' && c.high >= pos.entry) || (pos.type === 'SELL STOP' && c.low <= pos.entry);
      if (!fill) continue;
      pos.status = 'open'; pos.opened = Date.now();
      addLog(`${ACC_LABEL[pos.acc]} ${pos.symbol} ${pos.type} filled at ${fmt(pos.entry, pos.prec)}.`);
      toast(`${ACC_LABEL[pos.acc]} ${pos.symbol} ${pos.type} filled at ${fmt(pos.entry, pos.prec)}`);
      chartEvent(pos, 'Entry', 'entry');
    }
    if (pos.status !== 'open') break;
    const tol = tolFor(pos.market, c.close);
    // before TP1: SL with allowance. After TP1 (stop at entry): needs a clear move back through entry.
    const hitSL = pos.sl == null ? false : pos.tp1Hit ? (sg > 0 ? c.low <= pos.sl - tol : c.high >= pos.sl + tol) : (sg > 0 ? c.low <= pos.sl + tol : c.high >= pos.sl - tol);
    // after TP1 the stop is at entry; don't judge it on the same candle that hit TP1
    if (hitSL && (live || !(pos.tp1Hit && c.time <= (pos.tp1At ?? 0)))) { closePart(pos, pos.sl, pos.remaining, pos.tp1Hit ? 'Break-even stop' : 'Stop loss hit'); break; }
    if (!pos.tp1Hit && pos.tp1 != null && (sg > 0 ? c.high >= pos.tp1 - tol : c.low <= pos.tp1 + tol)) { pos.tp1Hit = true; pos.tp1At = c.time; closePart(pos, pos.tp1, pos.units / 2, 'TP1 hit (half closed, SL → entry)'); pos.sl = pos.entry; }
    if (pos.status === 'open' && pos.tp2 != null && (sg > 0 ? c.high >= pos.tp2 - tol : c.low <= pos.tp2 + tol)) { closePart(pos, pos.tp2, pos.remaining, 'TP2 hit'); break; }
  }
  if (candles.length && !live) pos.lastBar = Math.max(pos.lastBar ?? 0, candles[candles.length - 1].time);
}

/* ---------- live monitor (signals + both accounts) ---------- */
let monitoring = false;
async function monitor() {
  if (monitoring) return; monitoring = true;
  try {
    const sigs = S.signals.filter(g => ['waiting', 'active', 'tp1'].includes(g.status));
    const pos = [...S.accounts.demo.positions, ...S.accounts.real.positions].filter(p => p.status !== 'closed');
    const keys = new Set([...sigs, ...pos].map(x => x.market + '|' + x.symbol));
    for (const k of keys) {
      const [market, symbol] = k.split('|');
      let candles = [];
      try {
        if (market === 'cse') {
          const d = await fetchCandles(market, symbol, '1h', 5);
          const px = d.quote?.last ?? d.candles?.[d.candles.length - 1]?.close;
          if (px) candles = [{ time: nowSec(), open: px, high: px, low: px, close: px }];
        } else {
          // fetch enough 1m candles to cover everything since the oldest unchecked bar (catches missed TP/SL)
          const items = [...sigs, ...pos].filter(x => x.market + '|' + x.symbol === k);
          const from = Math.min(...items.map(x => x.lastBar ?? startBar(x.created)));
          const need = Math.min(1000, Math.max(10, Math.ceil((nowSec() - from) / 60) + 3));
          candles = (await fetchCandles(market, symbol, '1m', need)).candles || [];
        }
      } catch { continue; }
      if (!candles.length) continue;
      const px = candles[candles.length - 1].close;
      S.livePrices[k] = px;
      // drop broken items whose levels are nowhere near this symbol's real price (old bug: wrong chart data)
      const broken = x => Math.abs(x.entry - px) / px > 0.3;
      sigs.filter(g => g.market + '|' + g.symbol === k && broken(g)).forEach(g => { g.status = 'replaced'; addLog(`${g.symbol}: removed an invalid signal (levels didn't match the real price).`); });
      ['demo', 'real'].forEach(a => {
        const bad = S.accounts[a].positions.filter(p => p.market + '|' + p.symbol === k && broken(p));
        if (bad.length) { S.accounts[a].positions = S.accounts[a].positions.filter(p => !bad.includes(p)); addLog(`${ACC_LABEL[a]} ${k.split('|')[1]}: removed ${bad.length} invalid trade(s) — no P/L applied.`); }
      });
      sigs.filter(g => g.market + '|' + g.symbol === k && g.status !== 'replaced').forEach(g => processSignal(g, candles));
      pos.filter(p => p.market + '|' + p.symbol === k && S.accounts[p.acc].positions.includes(p)).forEach(p => processPosition(p, candles));
    }
    saveSignals(); saveAccounts();
  } finally {
    monitoring = false;
    renderSignals(); renderAccounts(); renderAcctCard();
  }
}

/* ---------- account UI ---------- */
function renderAcctCard() {
  const a = S.settings.active, acc = S.accounts[a], cur = curOf(S.market);
  $$('#acctSeg button').forEach(b => b.classList.toggle('on', b.dataset.acc === a));
  $('#balMain').textContent = money(acc[cur], cur);
  $('#balSub').textContent = `${ACC_LABEL[a]} · ${cur === 'USD' ? money(acc.LKR, 'LKR') + ' for CSE' : money(acc.USD, 'USD') + ' for USD markets'}`;
  $('#balMain').style.color = a === 'real' ? 'var(--gold)' : '';
  $('#demoChip').innerHTML = `${a === 'real' ? 'REAL' : 'DEMO'} <b>${money(acc[cur], cur)}</b>`;
}
function setActive(a) {
  S.settings.active = a; saveSettings(); renderAcctCard();
  if (S.analysis) renderResult(S.analysis);
  setAcctView(a);
}
function setAcctView(v) { S.acctView = v; $$('#acctViewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); renderAccounts(); }
function setAcctTab(t) { S.acctTab = t; $$('.tabs2 button').forEach(b => b.classList.toggle('on', b.dataset.dt === t)); renderAccounts(); }
function renderAccounts() {
  const v = S.acctView, d = S.accounts[v];
  const fl = { USD: 0, LKR: 0 }; let flPips = 0;
  d.positions.filter(p => p.status === 'open').forEach(p => {
    const px = S.livePrices[p.market + '|' + p.symbol]; if (px == null) return;
    fl[p.cur] += (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor;
    flPips += pipsOpen(p, px);
  });
  const pEl = $('#aPips'); if (pEl) { pEl.textContent = fmtPips(flPips); pEl.className = flPips >= 0 ? 'up' : 'down'; }
  $('#histPanel').classList.toggle('hidden', S.acctTab !== 'hist');
  $('#aBalUSD').textContent = money(d.USD, 'USD'); $('#aBalLKR').textContent = money(d.LKR, 'LKR');
  const fEl = $('#aFloat'); fEl.textContent = `${money(fl.USD, 'USD')}${fl.LKR ? ' · ' + money(fl.LKR, 'LKR') : ''}`; fEl.className = (fl.USD + fl.LKR) >= 0 ? 'up' : 'down';
  const wins = d.history.filter(h => h.pnl > 0).length;
  $('#aWin').textContent = d.history.length ? `${Math.round(wins / d.history.length * 100)}% (${d.history.length})` : '—';
  $('#btnResetAcc').textContent = v === 'real' ? 'Clear history' : 'Reset';
  $('#acctNote').textContent = v === 'real'
    ? 'Real account: Pryme never places real orders. Take the trade at your broker, press "Took on Real", and Pryme tracks it on the live price and updates your balance estimate. Edit the balance anytime to match your broker.'
    : 'Demo trades are checked against live prices every few seconds while this page is open. TP1 closes half and moves SL to entry; TP2 closes the rest.';
  const t = $('#posTable');
  if (S.acctTab === 'open') {
    if (!d.positions.length) { t.innerHTML = `<tr><td style="color:var(--dim);padding:18px 8px">No open ${ACC_LABEL[v].toLowerCase()} trades.</td></tr>`; return; }
    t.innerHTML = '<tr><th>Symbol</th><th>Side</th><th>Status</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Size</th><th>Now</th><th>Pips</th><th>P/L</th><th></th></tr>' + d.positions.map(p => {
      const px = S.livePrices[p.market + '|' + p.symbol];
      const pl = p.status === 'open' && px != null ? (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor + p.realized : p.realized;
      return `<tr><td>${p.code ? `<small class="tcode">${esc(p.code)}</small> ` : ''}${esc(p.symbol)} <small style="color:var(--dim)">${p.tf}</small>${p.auto ? ' <small class="autotag">AUTO</small>' : ''}</td><td class="${p.dir === 'long' ? 'up' : 'down'}">${p.dir === 'long' ? 'BUY' : 'SELL'}</td><td>${p.status === 'pending' ? esc(p.type) : p.tp1Hit ? 'Open · TP1 ✓' : 'Open'}</td><td>${fmt(p.entry, p.prec)}</td><td>${fmt(p.sl, p.prec)}</td><td>${fmt(p.tp1, p.prec)}</td><td>${fmt(p.tp2, p.prec)}</td><td>${fmtSize(p, p.remaining)}</td><td>${px != null ? fmt(px, p.prec) : '…'}</td>${(() => { const pp = p.status === 'open' && px != null ? pipsOpen(p, px) : null; return `<td class="${pp == null ? '' : pp >= 0 ? 'up' : 'down'}">${pp == null ? '—' : fmtPips(pp)}</td>`; })()}<td class="${pl >= 0 ? 'up' : 'down'}">${money(pl, p.cur)}</td><td class="acts">${p.status === 'open' ? `${!p.tp1Hit ? `<button class="mk ok" data-mark="tp1" data-id="${p.id}">TP1 ✓</button>` : ''}<button class="mk ok" data-mark="tp2" data-id="${p.id}">TP2 ✓</button><button class="mk bad" data-mark="sl" data-id="${p.id}">${p.tp1Hit ? 'BE' : 'SL ✗'}</button>` : ''}<button class="x" data-close-pos="${p.id}">${p.status === 'pending' ? 'Cancel' : 'Close'}</button></td></tr>`;
    }).join('');
  } else {
    renderHistory(v, d, t);
  }
}
// Mark TP/SL yourself (e.g. your broker / TradingView showed it hit). Closes at the exact level and triggers the next setup.
function markPosition(id, kind) {
  const acc = S.accounts[S.acctView], p = acc.positions.find(x => x.id === id); if (!p || p.status !== 'open') return;
  const bar = startBar(Date.now());
  if (kind === 'tp1' && !p.tp1Hit) { p.tp1Hit = true; p.tp1At = bar; closePart(p, p.tp1, p.units / 2, 'TP1 hit (half closed, SL → entry) · marked'); p.sl = p.entry; }
  else if (kind === 'tp2') closePart(p, p.tp2, p.remaining, 'TP2 hit · marked');
  else if (kind === 'sl') closePart(p, p.sl, p.remaining, p.tp1Hit ? 'Break-even stop · marked' : 'Stop loss hit · marked');
  const g = S.signals.find(x => x.id === p.sigId);
  if (g) { const map = { tp1: 'tp1', tp2: 'tp2', sl: p.tp1Hit ? 'be' : 'sl' }; if ((kind === 'tp1' && g.status === 'active') || (kind === 'tp2' && ['active', 'tp1'].includes(g.status)) || (kind === 'sl' && ['active', 'tp1'].includes(g.status))) applySignalMark(g, map[kind], true); }
  saveAccounts(); saveSignals(); renderAccounts(); renderAcctCard(); renderSignals();
}
function applySignalMark(g, e, quiet) {
  const bar = startBar(Date.now());
  if (e === 'tp1' && g.status === 'active') { g.status = 'tp1'; g.sl = g.entry; g.tp1At = bar; recordStat(g, true); }
  else if (e === 'tp2') { if (g.status === 'active') recordStat(g, true); g.status = 'tp2'; }
  else if (e === 'sl' && g.status === 'active') { g.status = 'sl'; recordStat(g, false); }
  else if (e === 'be' && g.status === 'tp1') { g.status = 'be'; }
  else return;
  g.lastBar = Math.max(g.lastBar ?? 0, bar);
  if (!quiet) onSignalEvent(g, e); else renderSignals();
}
function markSignal(id, e) {
  const g = S.signals.find(x => x.id === id); if (!g) return;
  applySignalMark(g, e, false); saveSignals();
}
function manualClose(id) {
  const acc = S.accounts[S.acctView];
  const p = acc.positions.find(x => x.id === id); if (!p) return;
  if (p.status === 'pending') { acc.positions = acc.positions.filter(x => x.id !== id); toast('Order cancelled'); }
  else {
    const px = S.livePrices[p.market + '|' + p.symbol];
    if (px == null) { toast('Waiting for live price…'); return; }
    closePart(p, px, p.remaining, 'Closed manually');
  }
  saveAccounts(); renderAccounts(); renderAcctCard();
}
let balTarget = 'demo';
function openBalModal(a) {
  balTarget = a;
  $('#bmTitle').textContent = `Edit ${ACC_LABEL[a]} balance`;
  $('#bmUSD').value = +(+S.accounts[a].USD).toFixed(2); $('#bmLKR').value = +(+S.accounts[a].LKR).toFixed(2);
  $('#bmNote').textContent = a === 'real' ? 'Enter the exact balance shown in your broker account. Position sizes and risk are calculated from this.' : 'Set any amount you want to practise with.';
  $('#balModal').classList.remove('hidden');
}

/* ---------------- settings: keys ---------------- */
function renderKeys() {
  const L = $('#keyList');
  if (!S.settings.keys.length) { L.innerHTML = '<p class="fine" style="margin:10px 0">No keys yet. Without a key, Pryme still gives setups from its built-in quant engine.</p>'; return; }
  L.innerHTML = S.settings.keys.map((k, i) => `
    <div class="keyrow" data-k="${i}">
      <select data-f="provider">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}" ${k.provider === id ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
      <input type="password" data-f="key" placeholder="API key" value="${esc(k.key || '')}" autocomplete="off">
      <input type="text" data-f="model" placeholder="${esc(PROVIDERS[k.provider]?.model || 'model')}" value="${esc(k.model || '')}">
      <button class="mini" data-test="${i}">Test</button>
      <button class="mini" data-del="${i}" title="Remove">✕</button>
    </div>`).join('');
}
async function testKey(i, btn) {
  const k = S.settings.keys[i]; btn.textContent = '…'; btn.className = 'mini';
  try {
    const r = await getJSON('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [k], system: 'Reply only with JSON.', prompt: 'Return {"ok":true}' }) });
    btn.textContent = 'OK'; btn.className = 'mini ok'; toast(`${PROVIDERS[k.provider].label} works · ${r.model}`);
  } catch (e) { btn.textContent = 'Fail'; btn.className = 'mini bad'; toast('Key test failed — check key/model'); }
}

/* ---------------- wiring ---------------- */
function setMarket(m, sym) {
  S.market = m; store.set('pa_market', m);
  S.symbol = sym || store.get('pa_sym_' + m, DEFAULT_SYM[m]);
  $$('#marketSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#symbolInput').value = S.symbol;
  S.searchHits = null; $('#symbolList').innerHTML = PICKS[m].map(s => `<option value="${s}">`).join('');
  $('#quickPicks').innerHTML = PICKS[m].map(s => `<button data-sym="${s}">${s.replace('.N0000', '')}</button>`).join('');
  renderAcctCard();
  return loadMarket();
}
function setSymbol(sym) {
  sym = sym.trim().toUpperCase(); if (!sym) return;
  S.symbol = sym; store.set('pa_sym_' + S.market, sym); $('#symbolInput').value = sym; loadMarket(); renderSignals();
}
function setTF(tf) { S.tf = tf; store.set('pa_tf', tf); $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf)); loadMarket(); }

function wire() {
  $('#marketSeg').onclick = e => { const b = e.target.closest('button'); if (b) setMarket(b.dataset.m).then(renderSignals); };
  $('#tfSeg').onclick = e => { const b = e.target.closest('button'); if (b) setTF(b.dataset.tf); };
  $('#quickPicks').onclick = e => { const b = e.target.closest('button'); if (b) setSymbol(b.dataset.sym); };
  $('#btnLoad').onclick = () => setSymbol($('#symbolInput').value);
  $('#symbolInput').onkeydown = e => { if (e.key === 'Enter') setSymbol(e.target.value); };
  // symbol search (any stock / coin / forex pair / CSE company)
  let sTimer, sSeq = 0;
  const doSearch = async q => {
    const my = ++sSeq;
    try {
      let items;
      if (S.market === 'crypto') { try { items = await searchCryptoLocal(q); } catch { } }
      if (!items) items = (await getJSON(`/api/search?market=${S.market}&q=${encodeURIComponent(q)}`)).items;
      if (my !== sSeq) return;
      S.searchHits = items || [];
      $('#symbolList').innerHTML = S.searchHits.map(x => `<option value="${esc(x.symbol)}">${esc(x.name || '')}</option>`).join('');
    } catch { }
  };
  $('#symbolInput').oninput = e => {
    const v = e.target.value.trim();
    if ((S.searchHits || []).some(x => x.symbol === v)) return setSymbol(v); // picked from list
    clearTimeout(sTimer); sTimer = setTimeout(() => doSearch(v), 280);
  };
  $('#symbolInput').onfocus = () => { if (!S.searchHits) doSearch(''); };
  $('#lvlBox').onclick = e => { if (e.target.closest('[data-lb-close]')) { S.lvlHidden = true; renderLvlBox(); } };

  // account
  $('#acctSeg').onclick = e => { const b = e.target.closest('button'); if (b) setActive(b.dataset.acc); };
  $('#btnEditBal').onclick = () => openBalModal(S.settings.active);
  $('#btnEditBal2').onclick = () => openBalModal(S.acctView);
  $('#bmSave').onclick = () => {
    const u = +$('#bmUSD').value, l = +$('#bmLKR').value;
    if (!(u >= 0) || !(l >= 0)) return toast('Enter valid amounts');
    S.accounts[balTarget].USD = u; S.accounts[balTarget].LKR = l; saveAccounts();
    $('#balModal').classList.add('hidden');
    addLog(`${ACC_LABEL[balTarget]} balance set to ${money(u, 'USD')} / ${money(l, 'LKR')}.`);
    renderAcctCard(); renderAccounts(); if (S.analysis) renderResult(S.analysis);
  };
  if (!(+S.settings.riskPct > 0)) { S.settings.riskPct = 1; saveSettings(); }
  $('#riskInput').value = S.settings.riskPct;
  $('#riskInput').oninput = e => { S.settings.riskPct = Math.max(0.1, Math.min(10, +e.target.value || 1)); saveSettings(); if (S.analysis) renderResult(S.analysis); };
  $('#btnAnalyse').onclick = runAnalysis;
  $('#btnBacktest').onclick = runBacktest;
  $('#btModal').addEventListener('click', e => { if (e.target.closest('#btUseHigh')) { S.settings.pro.mode = 'highwin'; S.settings.pro.enabled = true; saveSettings(); $('#proMode').value = 'highwin'; $('#proOn').checked = true; $('#btModal').classList.add('hidden'); toast('High win-rate mode on'); if (S.analysis) { S.setups.forEach(x => x.grade = gradeOf(x, S.analysis)); renderResult(S.analysis); } } });

  // auto settings
  const A = S.settings.auto;
  $('#autoOn').checked = A.enabled; $('#autoTrigger').value = A.trigger; $('#autoSL').checked = A.onSL;
  $('#autoExpiry').value = A.expiryBars; $('#autoTake').value = A.autoTake; $('#autoConf').value = A.minConf; $('#autoMax').value = A.maxOpen;
  $('#autoOn').onchange = e => {
    A.enabled = e.target.checked; saveSettings();
    if (A.enabled) { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { } }
    addLog(`Auto next setup ${A.enabled ? 'ON' : 'OFF'}.`);
  };
  $('#autoTrigger').onchange = e => { A.trigger = e.target.value; saveSettings(); };
  $('#autoSL').onchange = e => { A.onSL = e.target.checked; saveSettings(); };
  $('#autoExpiry').oninput = e => { A.expiryBars = Math.max(3, Math.min(200, +e.target.value || 16)); saveSettings(); };
  $('#autoTake').onchange = e => { A.autoTake = e.target.value; saveSettings(); };
  $('#autoConf').oninput = e => { A.minConf = Math.max(1, Math.min(95, +e.target.value || 60)); saveSettings(); };
  const P = S.settings.pro;
  $('#proMode').value = P.mode; $('#proMode').onchange = e => { P.mode = e.target.value; saveSettings(); toast(P.mode === 'highwin' ? 'High win-rate mode: fewer, stricter trades' : 'Balanced mode'); };
  $('#proOn').checked = P.enabled; $('#proRR').value = P.minRR; $('#proDaily').value = P.dailyPct; $('#proStreak').value = P.streak;
  const reGrade = () => { if (S.setups.length && S.analysis) { S.setups.forEach(s => s.grade = gradeOf(s, S.analysis)); renderResult(S.analysis); } };
  $('#proOn').onchange = e => { P.enabled = e.target.checked; saveSettings(); reGrade(); };
  $('#proRR').oninput = e => { P.minRR = Math.max(1, Math.min(5, +e.target.value || 1.8)); saveSettings(); reGrade(); };
  $('#proDaily').oninput = e => { P.dailyPct = Math.max(0.5, Math.min(20, +e.target.value || 3)); saveSettings(); reGrade(); };
  $('#proStreak').oninput = e => { P.streak = Math.max(1, Math.min(10, +e.target.value || 2)); saveSettings(); reGrade(); };
  $('#autoMax').oninput = e => { A.maxOpen = Math.max(1, Math.min(10, +e.target.value || 2)); saveSettings(); };

  $('#setups').onclick = e => {
    const s = e.target.closest('[data-show]'), t = e.target.closest('[data-trade]'), card = e.target.closest('.setup');
    if (t) return openTradeModal(+t.dataset.trade, t.dataset.acc);
    if (s) return drawSetupLines(+s.dataset.show);
    if (card) drawSetupLines(+card.dataset.i);
  };

  // modals
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden'); }));
  $('#btnSettings').onclick = () => { renderKeys(); $('#langSel').value = S.settings.lang; $('#settingsModal').classList.remove('hidden'); };
  $('#btnAddKey').onclick = () => { S.settings.keys.push({ provider: 'groq', key: '', model: '', enabled: true }); saveSettings(); renderKeys(); };
  $('#keyList').addEventListener('input', e => {
    const row = e.target.closest('.keyrow'); if (!row || e.target.dataset.f === 'provider') return;
    S.settings.keys[+row.dataset.k][e.target.dataset.f] = e.target.value.trim(); saveSettings();
  });
  $('#keyList').addEventListener('change', e => {
    if (e.target.dataset.f !== 'provider') return;
    const k = S.settings.keys[+e.target.closest('.keyrow').dataset.k]; k.provider = e.target.value; k.model = ''; saveSettings(); renderKeys();
  });
  $('#keyList').addEventListener('click', e => {
    const d = e.target.closest('[data-del]'), t = e.target.closest('[data-test]');
    if (d) { S.settings.keys.splice(+d.dataset.del, 1); saveSettings(); renderKeys(); }
    if (t) testKey(+t.dataset.test, t);
  });
  $('#langSel').onchange = e => { S.settings.lang = e.target.value; saveSettings(); };

  // trade modal
  ['#tmEntry', '#tmSL', '#tmTP1', '#tmTP2', '#tmUnits'].forEach(id => $(id).oninput = updateTmInfo);
  $('#tmAcc').onchange = fillUnits;
  $('#tmConfirm').onclick = placeTrade;

  // accounts section
  $('#acctViewSeg').onclick = e => { const b = e.target.closest('button'); if (b) setAcctView(b.dataset.v); };
  $('.tabs2').onclick = e => { const b = e.target.closest('button'); if (b) setAcctTab(b.dataset.dt); };
  $('#posTable').onclick = e => {
    const b = e.target.closest('[data-close-pos]'); if (b) return manualClose(b.dataset.closePos);
    const m = e.target.closest('[data-mark]'); if (m) markPosition(m.dataset.id, m.dataset.mark);
  };
  $('#sigList').onclick = e => { const m = e.target.closest('[data-smark]'); if (m) markSignal(m.dataset.id, m.dataset.smark); };
  $('#demoChip').onclick = () => document.getElementById('acctSection').scrollIntoView({ behavior: 'smooth' });
  $('#btnResetAcc').onclick = () => {
    const v = S.acctView;
    if (v === 'demo') {
      if (!confirm('Reset demo account? Balance goes back to $10,000 / Rs 1,000,000 and demo trades are cleared.')) return;
      S.accounts.demo = { USD: 10000, LKR: 1000000, positions: [], history: [] };
    } else {
      if (!confirm('Clear Real trade history? Your Real balance stays as it is.')) return;
      S.accounts.real.history = []; S.accounts.real.positions = [];
    }
    saveAccounts(); renderAccounts(); renderAcctCard(); toast('Done');
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) monitor(); });
}

/* ---------------- positions on the live chart ---------------- */
S.chartEvents = store.get('pa_events', []);
const saveEvents = () => store.set('pa_events', S.chartEvents.slice(-300));
let posLines = [], lastPosDraw = 0, lastTickRender = 0;
function chartItems() {
  const sym = S.symbol.toUpperCase(), out = [];
  ['demo', 'real'].forEach(a => S.accounts[a].positions.forEach(p => { if (p.market === S.market && p.symbol === sym && p.status !== 'closed') out.push(p); }));
  return out;
}
const plOf = (p, px) => (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor + p.realized;
function drawPositions(force = true) {
  drawTvPositions();
  if (!candleS) return;
  const now = Date.now(); if (!force && now - lastPosDraw < 700) return; lastPosDraw = now;
  posLines.forEach(l => { try { candleS.removePriceLine(l); } catch { } }); posLines = [];
  const px = S.candles.length ? S.candles[S.candles.length - 1].close : null;
  const add = (price, color, title, style = 0, w = 2) => { if (price == null || !isFinite(price)) return; posLines.push(candleS.createPriceLine({ price, color, lineWidth: w, lineStyle: style, axisLabelVisible: true, title })); };
  chartItems().forEach(p => {
    const side = p.dir === 'long' ? 'BUY' : 'SELL', A = p.acc === 'real' ? 'REAL' : 'DEMO';
    const pl = px != null && p.status === 'open' ? plOf(p, px) : null;
    const code = p.code || '#PQ';
    const lbl = p.status === 'pending' ? `${code} ${p.type}` : `${code} ${side} ENTRY${pl != null ? ` · ${fmtPips(pipsOpen(p, px))} pips` : ''}`;
    add(p.entry, p.status === 'pending' ? '#8892a4' : '#4ea8ff', lbl, p.status === 'pending' ? 2 : 0, 2);
    add(p.sl, '#ff4d6d', p.tp1Hit ? 'SL · BE' : 'SL', 0, 2);
    add(p.tp1, '#19e3a2', p.tp1Hit ? 'TP1 ✓' : 'TP1', 2, 1);
    add(p.tp2, '#19e3a2', p.manual ? 'TP' : 'TP2', 2, 1);
    if (p.tp3 && (p.tp3 - p.tp2) * (p.dir === 'long' ? 1 : -1) > 0) add(p.tp3, '#19e3a2', 'TP3', 2, 1);
  });
  drawBoxes();
}
function barAtOrBefore(t) {
  const cs = S.candles; if (!cs.length) return null;
  if (t <= cs[0].time) return cs[0].time;
  for (let i = cs.length - 1; i >= 0; i--) if (cs[i].time <= t) return cs[i].time;
  return cs[0].time;
}
function drawBoxes() { try { drawBoxesInner(); } catch { } }
function drawBoxesInner() {
  const layer = $('#posLayer'); if (!layer || !chart || !S.candles.length) { if (layer) layer.innerHTML = ''; return; }
  const ts = chart.timeScale(), y = v => candleS.priceToCoordinate(v);
  const w = $('#chart').clientWidth - chart.priceScale('right').width();
  const box = (x, a, b, cls) => {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return '';
    const ya = y(a), yb = y(b); if (ya == null || yb == null || !isFinite(ya) || !isFinite(yb)) return '';
    return `<div class="pbox ${cls}" style="left:${x}px;top:${Math.min(ya, yb)}px;width:${Math.max(0, w - x)}px;height:${Math.abs(ya - yb)}px"></div>`;
  };
  let html = '';
  const items = chartItems();
  items.forEach(p => {
    let x = ts.timeToCoordinate(barAtOrBefore(Math.floor((p.opened || p.created) / 1000)));
    x = Math.max(0, Math.min(x ?? 0, w - 24));
    html += box(x, p.entry, p.tp3 && (p.tp3 - p.tp2) * (p.dir === 'long' ? 1 : -1) > 0 ? p.tp3 : p.tp2, 'win') + box(x, p.entry, p.sl0 ?? p.sl, 'loss');
  });
  const s = S.setups[S.selected];
  if (s && !items.some(p => p.sigId && p.sigId === s.sigId)) {
    const x = Math.max(0, w - 110);
    html += box(x, s.entry, s.tp2, 'win prev') + box(x, s.entry, s.stopLoss, 'loss prev');
    if (s.zone) { const zx = Math.max(0, w - 260); html += box(zx, s.zone.lo, s.zone.hi, 'zone'); const yz = candleS.priceToCoordinate(s.zone.hi); if (yz != null) html += `<div class="zone-tag" style="left:${zx + 4}px;top:${yz - 16}px">LIMIT ZONE</div>`; }
  }
  layer.innerHTML = html;
}
function updateMarkers() {
  if (!candleS) return;
  const tfs = TF_SEC[S.tf] || 900, sym = S.symbol.toUpperCase(), first = S.candles[0]?.time || 0;
  const m = S.chartEvents.filter(e => e.market === S.market && e.symbol === sym && e.t >= first)
    .map(e => ({ time: barAtOrBefore(Math.floor(e.t / tfs) * tfs) ?? e.t, position: e.pos, color: e.color, shape: e.shape, text: e.text }));
  if (S.setupMarker) m.push(S.setupMarker);
  m.sort((a, b) => a.time - b.time);
  try { candleS.setMarkers(m); } catch { }
}
function chartEvent(x, text, kind) {
  const long = x.dir === 'long';
  S.chartEvents.push({
    market: x.market, symbol: x.symbol, t: nowSec(), text: `${x.acc === 'real' ? 'R' : 'D'} ${text}`,
    color: { tp: '#19e3a2', sl: '#ff4d6d', be: '#8892a4', entry: '#4ea8ff' }[kind],
    pos: kind === 'entry' ? (long ? 'belowBar' : 'aboveBar') : (kind === 'tp' ? (long ? 'aboveBar' : 'belowBar') : (long ? 'belowBar' : 'aboveBar')),
    shape: kind === 'entry' ? (long ? 'arrowUp' : 'arrowDown') : 'circle'
  });
  saveEvents();
  if (x.market === S.market && x.symbol === S.symbol.toUpperCase()) updateMarkers();
}
// every live tick: check TP / SL / entries of this symbol instantly
function liveCheck(px) {
  const sym = S.symbol.toUpperCase();
  const c = { time: startBar(Date.now()), open: px, high: px, low: px, close: px };
  const sig = x => [x.status, x.tp1Hit, x.remaining].join('|');
  let changed = false;
  S.signals.filter(g => g.market === S.market && g.symbol === sym && ['waiting', 'active', 'tp1'].includes(g.status))
    .forEach(g => { const b = sig(g); processSignal(g, [c], true); if (sig(g) !== b) changed = true; });
  ['demo', 'real'].forEach(a => S.accounts[a].positions.filter(p => p.market === S.market && p.symbol === sym).slice()
    .forEach(p => { const b = sig(p); processPosition(p, [c], true); if (sig(p) !== b) changed = true; }));
  if (changed) { saveSignals(); saveAccounts(); renderSignals(); renderAcctCard(); }
  const now = Date.now();
  if (changed || now - lastTickRender > 1000) { lastTickRender = now; renderAccounts(); drawPositions(changed); renderLvlBox(); }
}

/* ================================================================
   TradingView ADVANCED CHARTS (optional)
   When public/charting_library/ exists, the "TradingView live" tab becomes a full TradingView
   chart fed with Pryme's live data, and your trades are drawn on it with TradingView's own
   Long / Short Position tool (entry, SL, TP box) + TP1 line + Entry / TP / SL markers.
   ================================================================ */
const hasAdvanced = () => !!(window.TradingView && window.TradingView.widget);
const RES2TF = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', 'D': '1d', '1D': '1d' };
const TF2RES = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': '1D' };
let tvw = null, tvwReady = false, tvShapes = [], tvSig = '', tvSubs = {};
const tvDatafeed = {
  onReady: cb => setTimeout(() => cb({ supported_resolutions: Object.values(TF2RES), supports_marks: false, supports_timescale_marks: false, supports_time: true }), 0),
  searchSymbols: async (input, _ex, _type, onResult) => {
    try { const d = await getJSON(`/api/search?market=${S.market}&q=${encodeURIComponent(input)}`); onResult((d.items || []).map(x => ({ symbol: x.symbol, full_name: x.symbol, description: x.name || '', exchange: S.market.toUpperCase(), type: S.market }))); }
    catch { onResult([]); }
  },
  resolveSymbol: (name, onResolve) => setTimeout(() => {
    const prec = S.prec ?? 2;
    onResolve({
      name, ticker: name, description: (S.meta && S.meta.name) || name, type: S.market === 'crypto' ? 'crypto' : S.market === 'forex' ? 'forex' : 'stock',
      session: '24x7', timezone: 'Etc/UTC', exchange: S.market.toUpperCase(), listed_exchange: S.market.toUpperCase(),
      minmov: 1, pricescale: 10 ** prec, has_intraday: true, intraday_multipliers: ['1', '5', '15', '30', '60', '240'], has_daily: true,
      supported_resolutions: Object.values(TF2RES), volume_precision: 2, data_status: 'streaming', format: 'price'
    });
  }, 0),
  getBars: async (si, res, period, onResult, onError) => {
    if (!period.firstDataRequest) return onResult([], { noData: true });
    try {
      const tf = RES2TF[res] || S.tf;
      let cs = (si.name === S.symbol.toUpperCase() && tf === S.tf && S.candles.length) ? S.candles : (await fetchCandles(S.market, si.name, tf, 1000)).candles || [];
      const bars = cs.filter(c => c.time <= period.to).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
      onResult(bars, { noData: !bars.length });
    } catch (e) { onError(String(e.message || e)); }
  },
  subscribeBars: (si, res, onTick, uid) => { tvSubs[uid] = { sym: si.name, tf: RES2TF[res], onTick }; },
  unsubscribeBars: uid => { delete tvSubs[uid]; }
};
function tvForward(c) {
  Object.values(tvSubs).forEach(sub => {
    if (sub.sym === S.symbol.toUpperCase() && sub.tf === S.tf) { try { sub.onTick({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }); } catch { } }
  });
}
function ensureAdvanced() {
  const sym = S.symbol.toUpperCase(), res = TF2RES[S.tf];
  if (tvw) {
    if (tvwReady) {
      const ch = tvw.activeChart();
      if (ch.symbol() !== sym || ch.resolution() !== res) { tvSig = ''; tvw.setSymbol(sym, res, () => drawTvPositions()); }
    }
    return;
  }
  const w = $('#tvWrap'); w.dataset.src = 'advanced'; w.innerHTML = '<div id="tvAdv" style="width:100%;height:100%"></div>';
  tvw = new window.TradingView.widget({
    container: 'tvAdv', library_path: '/charting_library/', datafeed: tvDatafeed,
    symbol: sym, interval: res, locale: 'en', theme: 'dark', autosize: true, timezone: 'Asia/Colombo',
    disabled_features: ['use_localstorage_for_settings', 'header_symbol_search', 'header_compare', 'symbol_search_hot_key'],
    overrides: { 'paneProperties.background': '#07090d', 'paneProperties.backgroundType': 'solid', 'mainSeriesProperties.candleStyle.upColor': '#19e3a2', 'mainSeriesProperties.candleStyle.downColor': '#ff4d6d', 'mainSeriesProperties.candleStyle.wickUpColor': '#19e3a2', 'mainSeriesProperties.candleStyle.wickDownColor': '#ff4d6d', 'mainSeriesProperties.candleStyle.borderVisible': false }
  });
  tvw.onChartReady(() => {
    tvwReady = true; tvSig = ''; drawTvPositions();
    try {
      tvw.activeChart().onIntervalChanged().subscribe(null, iv => { const tf = RES2TF[iv]; if (tf && tf !== S.tf) setTF(tf); });
    } catch { }
  });
}
// draw your Demo / Real trades (and the selected AI setup) on the TradingView chart
function drawTvPositions() {
  if (!tvw || !tvwReady) return;
  const items = chartItems(), s = S.setups[S.selected];
  const sig = items.map(p => [p.id, p.status, p.tp1Hit, p.sl, p.remaining].join(':')).join(',') + '|' + (s ? s.sigId || S.selected : '') + '|' + S.symbol + S.tf
    + '|' + S.chartEvents.filter(e => e.symbol === S.symbol.toUpperCase()).length;
  if (sig === tvSig) return;
  tvSig = sig;
  let ch; try { ch = tvw.activeChart(); } catch { return; }
  tvShapes.forEach(id => { try { ch.removeEntity(id); } catch { } }); tvShapes = [];
  const keep = x => Promise.resolve(x).then(id => { if (id) tvShapes.push(id); }).catch(() => { });
  const scale = 10 ** (S.prec ?? 2), tfs = TF_SEC[S.tf] || 900;
  const lastT = S.candles.length ? S.candles[S.candles.length - 1].time : nowSec();
  const box = (dir, t0, entry, sl, tp, label) => {
    if (sl == null || tp == null) { if (label) ray(t0, entry, label, '#4ea8ff', 0); if (sl != null) ray(t0, sl, 'SL', '#ff4d6d', 0); if (tp != null) ray(t0, tp, 'TP', '#19e3a2'); return; }
    const t1 = Math.max(lastT + tfs * 12, t0 + tfs * 20);
    keep(ch.createMultipointShape([{ time: t0, price: entry }, { time: t1, price: entry }], {
      shape: dir === 'long' ? 'long_position' : 'short_position', lock: true, disableUndo: true,
      overrides: { profitLevel: Math.max(1, Math.round(Math.abs(tp - entry) * scale)), stopLevel: Math.max(1, Math.round(Math.abs(entry - sl) * scale)) }
    }));
    keep(ch.createShape({ time: t0, price: entry }, { shape: 'horizontal_ray', lock: true, disableUndo: true, overrides: { linecolor: '#4ea8ff', linewidth: 1, showLabel: true, text: label, textcolor: '#4ea8ff', fontsize: 11, horzLabelsAlign: 'right', vertLabelsAlign: 'bottom' } }));
  };
  function ray(t0, price, text, color, style = 2) { if (price == null) return; return keep(ch.createShape({ time: t0, price }, { shape: 'horizontal_ray', lock: true, disableUndo: true, overrides: { linecolor: color, linewidth: 1, linestyle: style, showLabel: true, text, textcolor: color, fontsize: 11, horzLabelsAlign: 'right', vertLabelsAlign: 'top' } })); }
  try {
    items.forEach(p => {
      const t0 = barAtOrBefore(Math.floor((p.opened || p.created) / 1000)) || lastT;
      const side = p.dir === 'long' ? 'BUY' : 'SELL';
      const label = `${p.code || ''} ${p.status === 'pending' ? p.type : side + ' ENTRY'} ${fmt(p.entry, p.prec)} · ${p.acc === 'real' ? 'REAL' : 'DEMO'}${p.tp1Hit ? ' · TP1 ✓ SL→BE' : ''}`;
      box(p.dir, t0, p.entry, p.sl === p.entry ? p.sl0 ?? p.sl : p.sl, p.tp2, label);
      if (!p.tp1Hit) ray(t0, p.tp1, 'TP1', '#19e3a2');
      if (p.tp1Hit) ray(t0, p.sl, 'SL (break-even)', '#ff4d6d', 0);
    });
    if (s && !items.some(p => p.sigId && p.sigId === s.sigId)) {
      box(s.direction, lastT, s.entry, s.stopLoss, s.tp2, `AI setup #${S.selected + 1} · ${s.direction === 'long' ? 'BUY' : 'SELL'} ${fmt(s.entry)}`);
      ray(lastT, s.tp1, 'TP1', '#19e3a2');
    }
    // Entry / TP / SL markers
    const first = S.candles[0]?.time || 0;
    S.chartEvents.filter(e => e.market === S.market && e.symbol === S.symbol.toUpperCase() && e.t >= first).slice(-40).forEach(e => {
      const t = barAtOrBefore(Math.floor(e.t / tfs) * tfs) || e.t;
      const up = e.pos === 'belowBar';
      keep(ch.createShape({ time: t }, { shape: up ? 'arrow_up' : 'arrow_down', lock: true, disableUndo: true, text: e.text, overrides: { color: e.color, arrowColor: e.color, text: e.text, fontsize: 12 } }));
    });
  } catch (e) { console.warn('TradingView drawing failed', e); }
}

/* ================================================================
   PIPS + PERFORMANCE (history periods, stats, equity curve, CSV)
   ================================================================ */
// pip size: forex 0.0001 (JPY pairs 0.01), gold 0.10, silver 0.01, indices 1.0,
// stocks / CSE 0.01, crypto ≈ 4 significant digits (BTC $1, ETH $0.1, SOL $0.01 …)
function pipSizeFor(market, symbol, price) {
  const s = String(symbol || '').toUpperCase();
  if (market === 'forex') {
    if (/^XAU|^GOLD/.test(s)) return 0.1;
    if (/^XAG|^SILVER/.test(s)) return 0.01;
    if (/OIL|WTI/.test(s)) return 0.01;
    if (s === 'DXY') return 0.01;
    if (/NAS100|US30|SPX500|US500|US100|GER40|UK100|JP225|NDX|DJI/.test(s)) return 1;
    if (/^[A-Z]{6}$/.test(s)) return s.endsWith('JPY') ? 0.01 : 0.0001;
    return 0.0001;
  }
  if (market === 'crypto') { const p = Math.abs(+price) || 1; return Math.pow(10, Math.floor(Math.log10(p)) - 4); }
  return 0.01;
}
const pipOf = p => p.pip || pipSizeFor(p.market, p.symbol, p.entry);
// size as traders read it: forex/metals in lots, crypto in coins, stocks in shares
function fmtSize(p, units) {
  const u = +units; if (!(u > 0)) return '—';
  const cs = contractSize(p.market, p.symbol);
  if (cs > 1) return `${(u / cs).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} lot`;
  if (p.market === 'crypto') return u.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return Math.round(u).toLocaleString('en-US');
}
const pipsOpen = (p, px) => (px - p.entry) * (p.dir === 'long' ? 1 : -1) / pipOf(p);
// closed trade pips = size-weighted average move (handles the TP1 half-close correctly)
const pipsClosed = h => (h.units && h.factor) ? h.pnl / (h.units * h.factor) / pipOf(h) : (h.exit - h.entry) * (h.dir === 'long' ? 1 : -1) / pipOf(h);
const fmtPips = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}`;
const PERIODS = [['24h', '24H', 864e5], ['3d', '3 days', 3 * 864e5], ['7d', '7 days', 7 * 864e5], ['30d', '30 days', 30 * 864e5], ['1y', '1 year', 365 * 864e5], ['all', 'All', Infinity]];
S.histPeriod = store.get('pa_hperiod', '7d');
S.histSymbol = 'all';
function durTxt(ms) {
  if (!(ms > 0)) return '—';
  const m = Math.round(ms / 60000); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`;
  return Math.round(h / 24) + 'd';
}
function periodTrades(d) {
  const span = (PERIODS.find(x => x[0] === S.histPeriod) || PERIODS[2])[2];
  const from = Date.now() - span;
  return d.history.filter(h => (h.closed || 0) >= from && (S.histSymbol === 'all' || h.symbol === S.histSymbol));
}
function calcStats(list) {
  const eps = 1e-9, n = list.length;
  const wins = list.filter(h => h.pnl > eps), losses = list.filter(h => h.pnl < -eps);
  const pips = list.map(pipsClosed);
  const pipsWon = pips.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const pipsLost = -pips.filter(x => x < 0).reduce((a, b) => a + b, 0);
  const curs = [...new Set(list.map(h => h.cur))];
  const main = curs.includes('USD') || !curs.length ? 'USD' : curs[0];
  const net = {}; curs.forEach(c => net[c] = list.filter(h => h.cur === c).reduce((a, h) => a + h.pnl, 0));
  const mainList = list.filter(h => h.cur === main);
  const gp = mainList.filter(h => h.pnl > 0).reduce((a, h) => a + h.pnl, 0), gl = -mainList.filter(h => h.pnl < 0).reduce((a, h) => a + h.pnl, 0);
  // equity curve + max drawdown (oldest → newest)
  const chron = [...mainList].sort((a, b) => a.closed - b.closed);
  let eq = 0, peak = 0, dd = 0; const curve = [0];
  chron.forEach(h => { eq += h.pnl; curve.push(eq); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); });
  // current streak
  let streak = 0, streakType = '';
  for (const h of [...list].sort((a, b) => b.closed - a.closed)) {
    const t = h.pnl > eps ? 'W' : h.pnl < -eps ? 'L' : '';
    if (!t) continue; if (!streakType) streakType = t; if (t !== streakType) break; streak++;
  }
  const withPips = list.map((h, i) => ({ h, p: pips[i] }));
  const best = withPips.reduce((m, x) => !m || x.p > m.p ? x : m, null), worst = withPips.reduce((m, x) => !m || x.p < m.p ? x : m, null);
  const holds = list.map(h => h.closed - (h.opened || h.created)).filter(x => x > 0);
  return {
    n, wins: wins.length, losses: losses.length, be: n - wins.length - losses.length,
    winRate: (wins.length + losses.length) ? wins.length / (wins.length + losses.length) * 100 : null,
    pipsWon, pipsLost, netPips: pipsWon - pipsLost, net, main, gp, gl,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    avgWinPips: wins.length ? wins.reduce((a, h) => a + pipsClosed(h), 0) / wins.length : null,
    avgLossPips: losses.length ? -losses.reduce((a, h) => a + pipsClosed(h), 0) / losses.length : null,
    expectancy: n ? (pipsWon - pipsLost) / n : null,
    curve, dd, streak, streakType, best, worst,
    avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null
  };
}
function equitySVG(curve, cur, fmtFn) {
  if (curve.length < 2) return '<div class="eq-empty">The equity curve appears after your first closed trades.</div>';
  const W = 600, H = 120, P = 6, min = Math.min(...curve), max = Math.max(...curve), rng = (max - min) || 1;
  const X = i => P + i * (W - 2 * P) / (curve.length - 1), Y = v => H - P - (v - min) * (H - 2 * P) / rng;
  const pts = curve.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const last = curve[curve.length - 1], col = last >= 0 ? 'var(--long)' : 'var(--short)';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="eq-svg" role="img" aria-label="Equity curve">
    <line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" class="eq-zero"/>
    <polygon points="${X(0)},${Y(0)} ${pts} ${X(curve.length - 1)},${Y(0)}" style="fill:${col};opacity:.12"/>
    <polyline points="${pts}" style="fill:none;stroke:${col};stroke-width:2;vector-effect:non-scaling-stroke"/>
  </svg><div class="eq-foot"><span>Start</span><b class="${last >= 0 ? 'up' : 'down'}">${fmtFn ? fmtFn(last) : (last >= 0 ? '+' : '') + money(last, cur)}</b></div>`;
}
function renderHistory(v, d, t) {
  const panel = $('#histPanel');
  const symbols = [...new Set(d.history.map(h => h.symbol))].sort();
  if (S.histSymbol !== 'all' && !symbols.includes(S.histSymbol)) S.histSymbol = 'all';
  const list = periodTrades(d), st = calcStats(list);
  const netTxt = Object.keys(st.net).length ? Object.entries(st.net).map(([c, x]) => `${x >= 0 ? '+' : ''}${money(x, c)}`).join(' · ') : money(0, 'USD');
  const netPos = Object.values(st.net).reduce((a, b) => a + b, 0) >= 0;
  const card = (label, val, cls = '', sub = '') => `<div class="st-card"><small>${label}</small><b class="${cls}">${val}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  panel.innerHTML = `
    <div class="hp-bar">
      <div class="seg small period-seg">${PERIODS.map(([k, l]) => `<button data-period="${k}" class="${S.histPeriod === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="hp-right">
        <select id="histSym" aria-label="Symbol"><option value="all">All symbols</option>${symbols.map(x => `<option ${S.histSymbol === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <button class="ghost" id="btnCsv" ${list.length ? '' : 'disabled'}>⬇ Export CSV</button>
      </div>
    </div>
    <div class="st-grid">
      ${card('Trades', st.n, '', `${st.wins} won · ${st.losses} lost${st.be ? ` · ${st.be} BE` : ''}`)}
      ${card('Win rate', st.winRate == null ? '—' : st.winRate.toFixed(1) + '%', st.winRate == null ? '' : st.winRate >= 50 ? 'up' : 'down')}
      ${card('Pips won', fmtPips(st.pipsWon), 'up', `${st.wins} winning trades`)}
      ${card('Pips lost', fmtPips(-st.pipsLost), 'down', `${st.losses} losing trades`)}
      ${card('Net pips', fmtPips(st.netPips), st.netPips >= 0 ? 'up' : 'down', st.expectancy == null ? '' : `${fmtPips(st.expectancy)} per trade`)}
      ${card('Net profit', netTxt, netPos ? 'up' : 'down')}
      ${card('Profit factor', st.pf == null ? '—' : st.pf === Infinity ? '∞' : st.pf.toFixed(2), st.pf == null ? '' : st.pf >= 1 ? 'up' : 'down', 'gross profit ÷ gross loss')}
      ${card('Avg win / loss', `${st.avgWinPips == null ? '—' : fmtPips(st.avgWinPips)} / ${st.avgLossPips == null ? '—' : fmtPips(-st.avgLossPips)}`, '', 'pips')}
      ${card('Max drawdown', st.dd ? '−' + money(st.dd, st.main) : money(0, st.main), st.dd ? 'down' : '', 'from equity peak')}
      ${card('Best trade', st.best ? fmtPips(st.best.p) : '—', 'up', st.best ? esc(st.best.h.symbol) : '')}
      ${card('Worst trade', st.worst ? fmtPips(st.worst.p) : '—', 'down', st.worst ? esc(st.worst.h.symbol) : '')}
      ${card('Streak', st.streak ? `${st.streak} ${st.streakType === 'W' ? 'wins' : 'losses'}` : '—', st.streakType === 'W' ? 'up' : st.streakType === 'L' ? 'down' : '', st.avgHold ? `avg hold ${durTxt(st.avgHold)}` : '')}
    </div>
    <div class="eq-wrap"><div class="eq-head">Equity curve <small>${(PERIODS.find(x => x[0] === S.histPeriod) || [])[1] || ''} · ${st.main}</small></div>${equitySVG(st.curve, st.main)}</div>
    ${symbols.length > 1 && S.histSymbol === 'all' && list.length ? `<div class="by-sym"><div class="eq-head">By symbol</div><table><tr><th>Symbol</th><th>Trades</th><th>Win %</th><th>Net pips</th><th>P/L</th></tr>${[...new Set(list.map(h => h.symbol))].map(sym => { const x = calcStats(list.filter(h => h.symbol === sym)); const pl = Object.entries(x.net).map(([c, v]) => `${v >= 0 ? '+' : ''}${money(v, c)}`).join(' · '); return `<tr><td>${esc(sym)}</td><td>${x.n}</td><td>${x.winRate == null ? '—' : x.winRate.toFixed(0) + '%'}</td><td class="${x.netPips >= 0 ? 'up' : 'down'}">${fmtPips(x.netPips)}</td><td class="${Object.values(x.net).reduce((a, b) => a + b, 0) >= 0 ? 'up' : 'down'}">${pl}</td></tr>`; }).join('')}</table></div>` : ''}`;
  const gOk = list.filter(h => h.ok === true), gNo = list.filter(h => h.ok === false);
  if (gOk.length || gNo.length) {
    const row = (lbl, arr) => { const x = calcStats(arr); return `<tr><td>${lbl}</td><td>${x.n}</td><td class="${x.winRate >= 50 ? 'up' : 'down'}">${x.winRate == null ? '—' : x.winRate.toFixed(0) + '%'}</td><td class="${x.netPips >= 0 ? 'up' : 'down'}">${fmtPips(x.netPips)}</td><td>${Object.entries(x.net).map(([c, v2]) => `${v2 >= 0 ? '+' : ''}${money(v2, c)}`).join(' · ') || '—'}</td></tr>`; };
    panel.insertAdjacentHTML('beforeend', `<div class="by-sym"><div class="eq-head">Pro filter result <small>did following the checklist pay?</small></div><table><tr><th>Setups</th><th>Trades</th><th>Win %</th><th>Net pips</th><th>P/L</th></tr>${gOk.length ? row('✓ TRADE (passed)', gOk) : ''}${gNo.length ? row('⏸ WATCH ONLY (taken anyway)', gNo) : ''}</table></div>`);
  }
  if (!list.length) { t.innerHTML = `<tr><td style="color:var(--dim);padding:18px 8px">No closed ${ACC_LABEL[v].toLowerCase()} trades in this period.</td></tr>`; return; }
  t.innerHTML = '<tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Size</th><th>Pips</th><th>Hold</th><th>Result</th><th>P/L</th></tr>' + list.slice(0, 300).map(h => {
    const pp = pipsClosed(h);
    return `<tr><td>${new Date(h.closed).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${h.code ? `<small class="tcode">${esc(h.code)}</small> ` : ''}${esc(h.symbol)}</td><td class="${h.dir === 'long' ? 'up' : 'down'}">${h.dir === 'long' ? 'BUY' : 'SELL'}</td><td>${fmt(h.entry, h.prec)}</td><td>${fmt(h.exit, h.prec)}</td><td>${fmtSize(h, h.units)}</td><td class="${pp >= 0 ? 'up' : 'down'}">${fmtPips(pp)}</td><td>${durTxt(h.closed - (h.opened || h.created))}</td><td>${esc(h.reason)}</td><td class="${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}${money(h.pnl, h.cur)}</td></tr>`;
  }).join('');
}
function exportCSV() {
  const d = S.accounts[S.acctView], list = periodTrades(d);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Trade', 'Opened', 'Closed', 'Account', 'Market', 'Symbol', 'Side', 'Entry', 'Exit', 'Stop loss', 'TP1', 'TP2', 'Size', 'Pips', 'P/L', 'Currency', 'Result', 'Setup']]
    .concat(list.map(h => [h.code || '', new Date(h.opened || h.created).toISOString(), new Date(h.closed).toISOString(), ACC_LABEL[S.acctView], h.market, h.symbol, h.dir === 'long' ? 'BUY' : 'SELL', h.entry, h.exit, h.sl0 ?? h.sl, h.tp1, h.tp2, h.units, pipsClosed(h).toFixed(1), (+h.pnl).toFixed(2), h.cur, h.reason, h.name]));
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `pryme-${S.acctView}-${S.histPeriod}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Exported ${list.length} trades`);
}
function wireHistory() {
  const panel = $('#histPanel');
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-period]');
    if (b) { S.histPeriod = b.dataset.period; store.set('pa_hperiod', S.histPeriod); renderAccounts(); return; }
    if (e.target.closest('#btnCsv')) exportCSV();
  });
  panel.addEventListener('change', e => { if (e.target.id === 'histSym') { S.histSymbol = e.target.value; renderAccounts(); } });
}

/* ================================================================
   PRO FILTER — fewer, better trades
   ================================================================ */
S.calendar = []; S.calendarAt = 0;
async function loadCalendar() {
  if (Date.now() - S.calendarAt < 30 * 60 * 1000) return;
  try { const d = await getJSON('/api/calendar'); S.calendar = d.events || []; S.calendarAt = Date.now(); } catch { }
}
function currenciesOf(market, symbol) {
  const s = String(symbol).toUpperCase();
  if (market === 'forex') {
    if (/^XAU|^XAG|^GOLD|^SILVER|OIL|WTI|US30|NAS100|SPX500|US500|US100|DXY/.test(s)) return ['USD'];
    if (/GER40/.test(s)) return ['EUR']; if (/UK100/.test(s)) return ['GBP']; if (/JP225/.test(s)) return ['JPY'];
    if (/^[A-Z]{6}$/.test(s)) return [s.slice(0, 3), s.slice(3)];
  }
  if (market === 'crypto') return ['USD'];
  if (market === 'stock') return /\.[A-Z]{1,3}$/.test(s) ? [] : ['USD'];
  return [];
}
// high-impact events for this symbol from `before` minutes ago to `after` minutes ahead
function newsNear(market, symbol, after = 45, before = 30) {
  const cur = currenciesOf(market, symbol), now = Date.now();
  return S.calendar.filter(e => cur.includes(e.cur) && /high/i.test(e.impact) && e.t >= now - before * 60000 && e.t <= now + after * 60000).sort((a, b) => a.t - b.t);
}
function setupKind(name) {
  const n = String(name || '').toLowerCase();
  return /break/.test(n) ? 'breakout' : /fib|golden/.test(n) ? 'fib' : /pullback|retest|ema/.test(n) ? 'pullback' : /revers|counter|fade|range/.test(n) ? 'reversal' : /trend|continu|market/.test(n) ? 'trend' : 'other';
}
// make stops survive normal noise and put TP1 where it gets hit often
function proAdjust(s, ctx = {}) {
  const P = S.settings.pro, I = ctx.I || S.ind; if (!P.enabled || !I) return;
  const a = I.atr, sg = s.direction === 'long' ? 1 : -1;
  const tp1R = P.mode === 'highwin' ? 0.7 : 1;
  const minSL = P.minSlAtr * a;
  if (Math.abs(s.entry - s.stopLoss) < minSL) { s.stopLoss = s.entry - sg * minSL; s.adjusted = true; }
  const R = Math.abs(s.entry - s.stopLoss);
  const d1 = Math.abs(s.tp1 - s.entry);
  if (d1 > R * tp1R * 1.05 || d1 < R * tp1R * 0.8) { s.tp1 = s.entry + sg * R * tp1R; s.adjusted = true; }
  if ((s.tp2 - s.tp1) * sg <= 0) s.tp2 = s.entry + sg * R * 2;
  if ((s.tp3 - s.tp2) * sg <= 0) s.tp3 = s.entry + sg * R * 3;
  if (s.adjusted && !/Pro filter/.test(s.reasoning)) s.reasoning = (s.reasoning ? s.reasoning + ' ' : '') + `(Pro filter: stop beyond the noise, TP1 at ${tp1R}R → half closes and SL moves to entry.)`;
}
function lossStreak(symbol) {
  const list = S.sigStats.filter(x => x.symbol === symbol).sort((a, b) => b.t - a.t);
  let n = 0; for (const x of list) { if (x.win) break; n++; }
  return { n, last: list[0]?.t || 0 };
}
// pauses: loss streak on a symbol, or the daily loss limit of the active account
function riskGuard(symbol = S.symbol.toUpperCase()) {
  const P = S.settings.pro; if (!P.enabled) return { block: false };
  const ls = lossStreak(symbol);
  if (ls.n >= P.streak && Date.now() - ls.last < P.pauseHours * 3600e3) {
    const until = ls.last + P.pauseHours * 3600e3;
    return { block: true, until, why: `${ls.n} losses in a row on ${symbol} — cooling down until ${new Date(until).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' })}` };
  }
  const acc = ACC(), cur = curOf(S.market);
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
  const todayPnl = acc.history.filter(h => h.cur === cur && new Date(h.closed).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' }) === day).reduce((a, h) => a + h.pnl, 0);
  const startBal = acc[cur] - todayPnl;
  if (startBal > 0 && todayPnl < 0 && -todayPnl >= startBal * P.dailyPct / 100) {
    return { block: true, why: `daily loss limit reached (${money(todayPnl, cur)} today, limit ${P.dailyPct}%). Stop for today — tomorrow is a new day.` };
  }
  return { block: false, todayPnl };
}
function proChecks(s, A, ctx = {}) {
  const P = S.settings.pro, I = ctx.I || S.ind || {}, d = s.direction, long = d === 'long', bt = !!ctx.bt;
  const R = Math.abs(s.entry - s.stopLoss), rr = Math.abs(s.tp2 - s.entry) / (R || 1e-9);
  const htf = A.htf?.bias;
  const news = bt ? [] : newsNear(S.market, S.symbol, P.newsMins, P.newsMins);
  const guard = bt ? { block: false } : riskGuard();
  const kind = setupKind(s.name), kst = bt ? [] : S.sigStats.filter(x => x.symbol === S.symbol.toUpperCase() && setupKind(x.name) === kind);
  const kWin = kst.length ? kst.filter(x => x.win).length / kst.length : 1;
  const nowD = new Date(ctx.t || Date.now()), utcH = nowD.getUTCHours() + nowD.getUTCMinutes() / 60, wd = nowD.getUTCDay();
  const fxClosed = S.market === 'forex' && (wd === 6 || (wd === 0 && utcH < 22) || (wd === 5 && utcH >= 21));
  const rollover = S.market === 'forex' && utcH >= 20.9 && utcH < 22.5;
  const checks = [
    { label: htf ? `HTF ${htf}` : 'HTF trend', ok: !htf || (long ? htf === 'bullish' : htf === 'bearish') || (htf === 'neutral' && /limit|range|revers/i.test(s.name + s.type)), hard: htf && htf !== 'neutral', tip: 'Trade in the direction of the higher timeframe' },
    { label: 'EMA trend', ok: !(I.ema50 && I.ema200) || (long ? I.ema50 >= I.ema200 || I.price > I.ema200 : I.ema50 <= I.ema200 || I.price < I.ema200), tip: 'Price / EMA50 on the right side of EMA200' },
    { label: I.adx ? `ADX ${I.adx.adx.toFixed(0)}` : 'Trend strength', ok: !I.adx || I.adx.adx >= P.minAdx || /limit/i.test(orderTypeOf(s, I.price, I.atr)), tip: `Choppy markets (ADX < ${P.minAdx}) stop out breakouts and market entries` },
    { label: `R:R ${rr.toFixed(1)}`, ok: rr >= P.minRR, hard: rr < 1.2, tip: `Reward to TP2 at least ${P.minRR}× the risk` },
    { label: `SL ${(R / (I.atr || 1)).toFixed(1)} ATR`, ok: R >= P.minSlAtr * (I.atr || 0) * 0.98, hard: R < 0.8 * (I.atr || 0), tip: 'Stop outside normal noise' },
    { label: I.rsi != null ? `RSI ${I.rsi.toFixed(0)}` : 'RSI', ok: I.rsi == null || (long ? I.rsi < 72 : I.rsi > 28), tip: 'Do not buy overbought / sell oversold' },
    { label: news.length ? `News: ${news[0].cur} ${news[0].title}` : 'No big news', ok: !news.length, hard: !!news.length, tip: `No high-impact news ±${P.newsMins} min` },
    { label: fxClosed ? 'Market closed' : rollover ? 'Rollover hour' : 'Good session', ok: !fxClosed && !rollover, hard: fxClosed, tip: 'Avoid the daily rollover (wide spreads) and closed markets' },
    ...(!bt && S.deep && S.deep.side ? [{ label: `${Math.round(S.deep.agree * 100)}% methods ${S.deep.side === d ? 'agree' : 'disagree'}`, ok: S.deep.side === d && S.deep.agree >= (P.mode === 'highwin' ? 0.65 : 0.55), hard: S.deep.side !== d && S.deep.agree >= 0.7, tip: 'Most of the 29 analysis methods must point the same way' }] : []),
    ...(!bt ? (() => { const z = sizing(s, S.market, S.symbol), pct = z.bal ? z.riskAmt / z.bal * 100 : 0, lim = Math.max(3, (+S.settings.riskPct || 1) * 2.5);
      return [{ label: pct > lim ? `Risk ${pct.toFixed(0)}% of balance` : 'Risk fits balance', ok: pct <= lim, hard: pct > lim, tip: pct > lim ? 'Even the smallest size risks too much of this balance on this stop — use a lower timeframe (5m/15m) for tighter stops, or a bigger balance' : 'The smallest broker size keeps risk within your limit' }]; })() : []),
    { label: guard.block ? 'Paused' : 'No loss streak', ok: !guard.block, hard: guard.block, tip: guard.why || 'Pauses after a loss streak or the daily loss limit' },
    { label: kst.length >= 4 ? `${kind} ${Math.round(kWin * 100)}% here` : `${kind} setup`, ok: kst.length < 4 || kWin >= 0.35, tip: 'This kind of setup has worked on this symbol before' }
  ];
  if (P.mode === 'highwin') {
    const h2 = A.htf2?.bias, type = orderTypeOf(s, I.price, I.atr), isLimit = /LIMIT/.test(type);
    const cf = bt ? I.conf1 : I.conf2;
    const lv = long ? (I.sup || []).map(x => x.p).concat([I.ema20, I.ema50]) : (I.res || []).map(x => x.p).concat([I.ema20, I.ema50]);
    const atLevel = lv.some(v => v && Math.abs(s.entry - v) <= 0.5 * I.atr) || (I.zones || []).some(z => z.side === d && s.entry >= z.lo - 0.3 * I.atr && s.entry <= z.hi + 0.3 * I.atr);
    const ext = Math.abs((isLimit ? s.entry : I.price) - (I.ema20 || I.price)) / (I.atr || 1);
    checks.push(
      { label: h2 ? `2nd HTF ${h2}` : '2nd HTF', ok: !h2 || (long ? h2 !== 'bearish' : h2 !== 'bullish'), hard: true, tip: 'Both higher timeframes must agree' },
      isLimit
        ? { label: atLevel ? 'At key level' : 'Not at a level', ok: atLevel, tip: 'Limit entries only at support/resistance or EMA20/50' }
        : { label: cf && (long ? cf.bull : cf.bear) ? 'Confirmed candle' : 'No confirmation', ok: !!(cf && (long ? cf.bull : cf.bear)), tip: 'Last closed candle must confirm the direction (engulfing / rejection / strong close)' },
      { label: `${ext.toFixed(1)} ATR from EMA20`, ok: ext <= 1.2, tip: 'Do not chase extended moves' },
      { label: S.market === 'forex' ? (utcH >= 7 && utcH < 20 ? 'London/NY' : 'Asian session') : 'Session', ok: S.market !== 'forex' || (utcH >= 7 && utcH < 20), tip: 'Forex & gold: only London and New York hours (12:30–01:30 Sri Lanka time)' }
    );
  }
  return checks;
}

/* ================================================================
   BACKTEST — how would Pryme's rules have done on this chart?
   Walks forward through real past candles (no peeking ahead), builds the quant setups,
   runs the same Pro checklist, then simulates entry → TP1 (half + SL to entry) → TP2 / SL.
   ================================================================ */
async function runBacktest() {
  const box = $('#btBody'); $('#btModal').classList.remove('hidden');
  box.innerHTML = '<div class="gate-loading"><span class="spin"></span></div><p class="fine" style="text-align:center">Testing on past candles…</p>';
  const market = S.market, sym = S.symbol, tf = S.tf;
  try {
    const [main, h1, h2] = await Promise.all([
      fetchCandles(market, sym, tf, 1000),
      HTF[tf] ? fetchCandles(market, sym, HTF[tf], 1000).catch(() => null) : null,
      HTF2[tf] ? fetchCandles(market, sym, HTF2[tf], 1000).catch(() => null) : null
    ]);
    const cs = main.candles || [];
    if (cs.length < 320) throw new Error('Not enough history for a backtest on this symbol/timeframe.');
    const tfs = TF_SEC[tf];
    const biasFn = (arr, sec) => {
      const cache = new Map(); arr = arr || [];
      return t => {
        let j = -1; for (let k = arr.length - 1; k >= 0; k--) if (arr[k].time + sec <= t) { j = k; break; }
        if (j < 80) return null;
        if (!cache.has(j)) { const I = analyseIndicators(arr.slice(Math.max(0, j - 299), j + 1)); cache.set(j, { bias: I.score > 15 ? 'bullish' : I.score < -15 ? 'bearish' : 'neutral' }); }
        return cache.get(j);
      };
    };
    const b1 = biasFn(h1?.candles, TF_SEC[HTF[tf]] || 0), b2 = biasFn(h2?.candles, TF_SEC[HTF2[tf]] || 0);
    // indicators at each closed bar (computed once, used by both modes)
    const IS = [];
    for (let i = 250; i < cs.length - 2; i++) { const I = analyseIndicators(cs.slice(Math.max(0, i - 399), i + 1)); IS[i] = I; }
    const P = S.settings.pro, saved = { ...P };
    const results = {};
    for (const mode of ['balanced', 'highwin']) {
      Object.assign(P, saved, { enabled: true, mode });
      const trades = []; let busy = 0;
      for (let i = 250; i < cs.length - 2; i++) {
        if (i < busy) continue;
        const I = IS[i]; if (!I || !I.atr) continue;
        const t = (cs[i].time + tfs) * 1000;
        const htf = b1(cs[i].time + tfs), htf2 = b2(cs[i].time + tfs);
        const q = quantSetups(I, htf?.bias);
        const A = { bias: q.bias, htf, htf2 };
        const cands = q.setups.map(x => ({ ...x }));
        cands.forEach(x => { proAdjust(x, { I }); x.grade = gradeOf(x, A, { I, t, bt: true }); });
        const s = cands.filter(x => x.ok).sort((a, b) => (b.grade === 'A+') - (a.grade === 'A+') || b.confidence - a.confidence)[0];
        if (!s) continue;
        const r = simulate(cs, i, s, I);
        if (!r) continue;
        trades.push(r); busy = r.exitIdx + 1;
      }
      results[mode] = btStats(trades, cs, tfs);
    }
    Object.assign(P, saved);
    const days = ((cs[cs.length - 1].time - cs[250].time) / 86400).toFixed(1);
    box.innerHTML = btHTML(results, sym, tf, days);
    const H = results.highwin; if (H.n) S.lastBacktest = `${H.wr.toFixed(0)}% win rate, ${H.netR >= 0 ? '+' : ''}${H.netR.toFixed(1)}R over ${H.n} trades`;
  } catch (e) {
    box.innerHTML = `<p class="ai-status err">Backtest failed: ${esc(e.message)}</p>`;
  }
}
// entry at the next bar; pending orders wait up to 8 bars; SL is checked first inside a bar (conservative)
function simulate(cs, i, s, I) {
  const sg = s.direction === 'long' ? 1 : -1;
  const type = orderTypeOf(s, I.price, I.atr);
  let k = i + 1, entry = s.entry;
  if (type.startsWith('MARKET')) {
    entry = cs[k].open;
    if ((entry - s.stopLoss) * sg <= 0) return null;
  } else {
    let filled = false;
    for (; k < Math.min(cs.length, i + 9); k++) {
      const c = cs[k];
      if ((type === 'BUY LIMIT' && c.low <= entry) || (type === 'SELL LIMIT' && c.high >= entry) || (type === 'BUY STOP' && c.high >= entry) || (type === 'SELL STOP' && c.low <= entry)) { filled = true; break; }
    }
    if (!filled) return null;
  }
  const R = Math.abs(entry - s.stopLoss);
  const tp1R = Math.abs(s.tp1 - entry) / R, tp2R = Math.abs(s.tp2 - entry) / R;
  let sl = s.stopLoss, tp1Hit = false;
  for (let j = k; j < Math.min(cs.length, k + 300); j++) {
    const c = cs[j];
    const hitSL = sg > 0 ? c.low <= sl : c.high >= sl;
    if (hitSL && !(tp1Hit && j === k)) return { win: tp1Hit, R: tp1Hit ? 0.5 * tp1R : -1, exitIdx: j, dir: s.direction, name: s.name, t: c.time };
    if (!tp1Hit && (sg > 0 ? c.high >= s.tp1 : c.low <= s.tp1)) { tp1Hit = true; sl = entry; }
    if (tp1Hit && (sg > 0 ? c.high >= s.tp2 : c.low <= s.tp2)) return { win: true, R: 0.5 * tp1R + 0.5 * tp2R, exitIdx: j, dir: s.direction, name: s.name, t: c.time };
  }
  return null; // still open at the end of the data
}
function btStats(tr, cs, tfs) {
  const n = tr.length, w = tr.filter(x => x.win).length;
  const gp = tr.filter(x => x.R > 0).reduce((a, x) => a + x.R, 0), gl = -tr.filter(x => x.R < 0).reduce((a, x) => a + x.R, 0);
  let streak = 0, maxL = 0; tr.forEach(x => { streak = x.win ? 0 : streak + 1; maxL = Math.max(maxL, streak); });
  let eq = 0; const curve = [0]; tr.forEach(x => { eq += x.R; curve.push(eq); });
  return { n, w, wr: n ? w / n * 100 : null, netR: gp - gl, pf: gl ? gp / gl : gp ? Infinity : null, avgR: n ? (gp - gl) / n : null, maxL, curve };
}
function btHTML(r, sym, tf, days) {
  const B = r.balanced, H = r.highwin;
  const cell = (x, f) => x.n ? f(x) : '—';
  const row = (lbl, f, cls) => `<tr><td>${lbl}</td><td class="${cls ? cls(B) : ''}">${cell(B, f)}</td><td class="${cls ? cls(H) : ''}">${cell(H, f)}</td></tr>`;
  const better = H.n && B.n && H.wr > B.wr;
  return `<p class="fine" style="margin:0 0 10px">${esc(sym.toUpperCase())} · ${tf} · last ${days} days of real candles · Pryme quant engine + Pro checklist (AI setups are not included — they can't be replayed).</p>
  <div class="table-wrap"><table class="bt-table"><tr><th></th><th>Balanced</th><th>High win-rate</th></tr>
    ${row('Trades', x => x.n)}
    ${row('Win rate (TP1 before SL)', x => x.wr.toFixed(0) + '%', x => x.wr >= 50 ? 'up' : 'down')}
    ${row('Wins / losses', x => `${x.w} / ${x.n - x.w}`)}
    ${row('Net result', x => (x.netR >= 0 ? '+' : '') + x.netR.toFixed(1) + 'R', x => x.netR >= 0 ? 'up' : 'down')}
    ${row('Avg per trade', x => (x.avgR >= 0 ? '+' : '') + x.avgR.toFixed(2) + 'R', x => x.avgR >= 0 ? 'up' : 'down')}
    ${row('Profit factor', x => x.pf === Infinity ? '∞' : x.pf.toFixed(2), x => x.pf >= 1 ? 'up' : 'down')}
    ${row('Longest losing streak', x => x.maxL)}
  </table></div>
  <div class="eq-wrap"><div class="eq-head">Equity in R <small>High win-rate mode</small></div>${equitySVG(H.curve, 'R', v => (v >= 0 ? '+' : '') + v.toFixed(1) + 'R')}</div>
  <p class="fine">1R = the amount you risk per trade (your risk % of balance). ${H.n < 15 ? 'Few trades — test a lower timeframe or another symbol for a bigger sample.' : ''} ${better ? 'High win-rate mode had the better win rate here.' : ''} Past results don't guarantee future results.</p>
  <div class="wc-actions"><button class="ghost" data-close>Close</button><button class="primary" id="btUseHigh">Use High win-rate mode</button></div>`;
}

// trade codes like #PQ001 (shown on the chart, tables and history)
function nextTradeCode() { const n = (store.get('pa_seq', 0) || 0) + 1; store.set('pa_seq', n); return '#PQ' + String(n).padStart(3, '0'); }

// TradingView-style legend: "BTCUSDT · 15 · BINANCE  O … H … L … C … change"
const TF_LABEL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '1H', '4h': '4H', '1d': '1D' };
function tvLegend(time) {
  const el = $('#tvLegend'); if (!el || !S.candles.length) return;
  S.legendHover = !!time;
  const cs = S.candles; let i = cs.length - 1;
  if (time) { const k = cs.findIndex(c => c.time === time); if (k >= 0) i = k; }
  const c = cs[i], prev = cs[i - 1] || c, ch = c.close - prev.close, pct = prev.close ? ch / prev.close * 100 : 0, cls = c.close >= c.open ? 'up' : 'down';
  const ex = (S.meta?.tv || '').split(':')[0] || S.market.toUpperCase();
  el.innerHTML = `<div class="tvl-1"><b>${esc(S.symbol.toUpperCase())}</b> · ${TF_LABEL[S.tf] || S.tf} · ${esc(ex)} <i class="tvl-dot"></i>
    <span class="${cls}">O<em>${fmt(c.open)}</em> H<em>${fmt(c.high)}</em> L<em>${fmt(c.low)}</em> C<em>${fmt(c.close)}</em> <em>${ch >= 0 ? '+' : ''}${fmt(ch)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</em></span></div>
    <div class="tvl-2">Vol <em class="${cls}">${(c.volume || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</em> <span class="e20">EMA 20</span> <span class="e50">EMA 50</span> <span class="e200">EMA 200</span></div>`;
}

/* ---------------- boot ---------------- */
initChart();
wire();
wireHistory();
$$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === S.tf));
setAcctView(S.acctView);
setMarket(S.market).then(renderSignals);
renderLog(); renderSignals(); renderAcctCard();
setInterval(monitor, 8000);
chart.timeScale().subscribeVisibleLogicalRangeChange(() => drawBoxes());
setInterval(drawBoxes, 600); // keeps boxes aligned when the price scale moves

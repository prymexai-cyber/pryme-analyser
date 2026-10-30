/* ============================================================
   PRYME ANALYSER — frontend
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
  ws: null, poll: null, view: 'pryme',
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
S.settings.auto = Object.assign({ enabled: true, trigger: 'tp1', onSL: true, expiryBars: 16, autoTake: 'off', minConf: 60, maxOpen: 2 }, S.settings.auto || {});
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
  return { bias: dir === 'long' ? 'BULLISH' : dir === 'short' ? 'BEARISH' : 'NEUTRAL', score, setups: out.slice(0, 4) };
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
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8892a4', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.035)' } },
    rightPriceScale: { borderColor: '#1d2633', scaleMargins: { top: 0.08, bottom: 0.2 } },
    timeScale: { borderColor: '#1d2633', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    crosshair: { mode: 0, vertLine: { color: '#3a475c', labelBackgroundColor: '#273244' }, horzLine: { color: '#3a475c', labelBackgroundColor: '#273244' } },
    localization: { timeFormatter: t => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) }
  });
  candleS = chart.addCandlestickSeries({ upColor: '#19e3a2', downColor: '#ff4d6d', borderVisible: false, wickUpColor: '#19e3a2', wickDownColor: '#ff4d6d' });
  volS = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  const line = c => chart.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  e20S = line('#4ea8ff'); e50S = line('#f6c24a'); e200S = line('#b07cff');
}
function drawSeries() {
  const cs = S.candles; if (!cs.length) return;
  S.prec = precisionFor(cs[cs.length - 1].close, S.market);
  candleS.applyOptions({ priceFormat: { type: 'price', precision: S.prec, minMove: 1 / 10 ** S.prec } });
  candleS.setData(cs.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  volS.setData(cs.map(c => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(25,227,162,.25)' : 'rgba(255,77,109,.25)' })));
  const I = S.ind;
  const ln = arr => cs.map((c, i) => arr[i] == null ? null : { time: c.time, value: arr[i] }).filter(Boolean);
  e20S.setData(ln(I.series.e20)); e50S.setData(ln(I.series.e50)); e200S.setData(ln(I.series.e200));
}
function clearLines() { S.priceLines.forEach(l => { try { candleS.removePriceLine(l); } catch { } }); S.priceLines = []; candleS.setMarkers([]); }
function drawSetupLines(idx) {
  clearLines();
  const s = S.setups[idx]; if (!s) return;
  S.selected = idx;
  const add = (price, color, title, style = 0, w = 2) => S.priceLines.push(candleS.createPriceLine({ price, color, lineWidth: w, lineStyle: style, axisLabelVisible: true, title }));
  add(s.entry, '#4ea8ff', `ENTRY #${idx + 1}`, 0, 2);
  add(s.stopLoss, '#ff4d6d', 'SL', 0, 2);
  add(s.tp1, '#19e3a2', 'TP1', 2, 1);
  add(s.tp2, '#19e3a2', 'TP2', 2, 2);
  add(s.tp3, '#19e3a2', 'TP3', 3, 1);
  // faint lines for other setups' entries
  S.setups.forEach((o, i) => { if (i !== idx) add(o.entry, 'rgba(78,168,255,.35)', `#${i + 1}`, 1, 1); });
  const last = S.candles[S.candles.length - 1];
  candleS.setMarkers([{ time: last.time, position: s.direction === 'long' ? 'belowBar' : 'aboveBar', color: s.direction === 'long' ? '#19e3a2' : '#ff4d6d', shape: s.direction === 'long' ? 'arrowUp' : 'arrowDown', text: s.direction === 'long' ? 'BUY' : 'SELL' }]);
  $$('.setup').forEach((el, i) => el.classList.toggle('sel', i === idx));
  if (S.view !== 'pryme') setView('pryme');
}

function tvSymbol() {
  const s = S.symbol.toUpperCase();
  if (S.market === 'crypto') return 'BINANCE:' + s.replace(/[^A-Z0-9]/g, '');
  if (S.market === 'cse') return 'CSELK:' + (s.includes('.') ? s : s + '.N0000');
  if (S.market === 'forex') {
    const m = { XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', NAS100: 'OANDA:NAS100USD', US30: 'OANDA:US30USD', SPX500: 'OANDA:SPX500USD', USOIL: 'TVC:USOIL' };
    return m[s] || 'FX:' + s.replace('/', '');
  }
  return s;
}
function setView(v) {
  S.view = v;
  $$('.chart-tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('#chart').classList.toggle('hidden', v !== 'pryme');
  $('#tvWrap').classList.toggle('hidden', v !== 'tv');
  if (v === 'tv') {
    const src = `https://s.tradingview.com/widgetembed/?frameElementId=tvf&symbol=${encodeURIComponent(tvSymbol())}&interval=${TV_INT[S.tf]}&theme=dark&style=1&timezone=Asia%2FColombo&withdateranges=1&allow_symbol_change=1&saveimage=0&studies=%5B%5D&locale=en`;
    const w = $('#tvWrap');
    if (w.dataset.src !== src) { w.innerHTML = `<iframe src="${src}" allowfullscreen loading="lazy"></iframe>`; w.dataset.src = src; }
  }
}

/* ---------------- data loading / live ---------------- */
async function fetchCandles(market, symbol, tf, limit = 500) {
  return getJSON(`/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${limit}`);
}
function setLive(on, label) { const p = $('#livePill'); p.classList.toggle('on', on); p.querySelector('span').textContent = label || (on ? 'LIVE' : 'OFFLINE'); }
function stopLive() { if (S.ws) { try { S.ws.close(); } catch { } S.ws = null; } clearInterval(S.poll); }

async function loadMarket(opts = {}) {
  stopLive(); clearLines();
  S.setups = []; renderResult(null);
  $('#symTitle').textContent = S.symbol.toUpperCase();
  $('#symSub').textContent = 'Loading data…';
  $('#chartMsg').classList.add('hidden');
  setLive(false, 'LOADING');
  try {
    const d = await fetchCandles(S.market, S.symbol, S.tf);
    S.meta = d;
    S.candles = d.candles || [];
    if (S.candles.length < 30 && S.market !== 'cse') throw new Error('Not enough data for this symbol/timeframe.');
    if (!S.candles.length) throw new Error('No price data returned.');
    S.ind = analyseIndicators(S.candles);
    drawSeries(); chart.timeScale().fitContent();
    if (S.candles.length > 150) chart.timeScale().setVisibleLogicalRange({ from: S.candles.length - 150, to: S.candles.length + 8 });
    updateHeader(); renderIndicators();
    $('#symSub').textContent = [d.name, d.symbol, S.market.toUpperCase(), S.tf].filter(Boolean).join(' · ');
    if (d.limited) { const m = $('#chartMsg'); m.textContent = 'CSE history is limited right now — the chart fills in as live prices come in. Use the TradingView tab for the full CSE chart. AI analysis still uses the day range and 52-week levels.'; m.classList.remove('hidden'); }
    startLive();
  } catch (e) {
    $('#symSub').textContent = 'Error';
    const m = $('#chartMsg'); m.textContent = 'Could not load data: ' + e.message + ' — check the symbol, or open the TradingView tab.'; m.classList.remove('hidden');
    setLive(false, 'ERROR');
  }
  if (S.view === 'tv') setView('tv');
  await loadNews();
}
function onTick(c) {
  const cs = S.candles; const last = cs[cs.length - 1];
  if (last && c.time === last.time) cs[cs.length - 1] = c; else if (!last || c.time > last.time) cs.push(c);
  candleS.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  volS.update({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(25,227,162,.25)' : 'rgba(255,77,109,.25)' });
  S.livePrices[S.market + '|' + S.symbol.toUpperCase()] = c.close;
  updateHeader();
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
  setLive(true, S.market === 'crypto' ? 'LIVE' : 'LIVE ~10s');
  const key = `${S.market}|${S.symbol}|${S.tf}`;
  S.poll = setInterval(async () => {
    if (document.hidden) return;
    try {
      const d = await fetchCandles(S.market, S.symbol, S.tf);
      if (`${S.market}|${S.symbol}|${S.tf}` !== key) return;
      d.candles.slice(-3).forEach(onTick);
    } catch { setLive(false, 'RETRYING'); }
  }, S.market === 'cse' ? 20000 : 10000);
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
  document.title = `${fmt(last)} ${S.symbol.toUpperCase()} · Pryme Analyser`;
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
    lastCandlePatterns: I.patterns, volumeVsAvg: I.volRatio && +I.volRatio.toFixed(2),
    higherTimeframe: htf, cseQuote: S.meta.quote || undefined,
    quantEngine: { score: quant.score, bias: quant.bias, candidateSetups: quant.setups.map(s => ({ name: s.name, direction: s.direction, entry: r(s.entry), stopLoss: r(s.stopLoss), tp1: r(s.tp1), tp2: r(s.tp2), tp3: r(s.tp3) })) },
    todaysHeadlines: S.news.slice(0, 8).map(n => n.title),
    recentSignalResultsOnThisSymbol: perfFor(S.symbol.toUpperCase()),
    account: { wallet: sz, balance: bal, currency: cur, riskPerTradePct: S.settings.riskPct }
  };
  return `Analyse this ${S.market.toUpperCase()} chart and give the best 3 to 4 trade setups on the ${S.tf} timeframe.

DATA (JSON):
${JSON.stringify(data)}

LAST 80 CANDLES (time UTC, open, high, low, close):
${cs.join('\n')}

Rules:
- Give exactly 3 or 4 setups. Mix entry styles where sensible (market now, pullback/limit at a zone, breakout/stop, or an opposite-direction setup at a key level if the market is ranging).
- Each setup: direction "long" or "short", entry, stopLoss, tp1, tp2, tp3 as plain numbers with ${p} decimals.
- For long: stopLoss < entry < tp1 < tp2 < tp3. For short: stopLoss > entry > tp1 > tp2 > tp3.
- Entries must be within ~3 ATR of current price. Use the candidate setups from the quant engine as a starting point but improve them with structure, liquidity and news.
- confidence = honest probability (0-100) that TP1 is hit before SL.
- WIN-RATE FIRST: quality over quantity. Rank the best setup first. Prefer entries at a level where liquidity was already swept or price is in discount (longs) / premium (shorts), aligned with the higher timeframe. Counter-trend ideas must get confidence below 50.
- Put stops beyond the liquidity (beyond the swing + a small ATR buffer), never at an obvious round number where stops get hunted. TP1 must be realistic (before the nearest opposing level) so it gets hit often.
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

async function htfInfo() {
  const h = HTF[S.tf]; if (!h) return null;
  try {
    const d = await fetchCandles(S.market, S.symbol, h, 400);
    if (!d.candles || d.candles.length < 50) return null;
    const I = analyseIndicators(d.candles);
    return { timeframe: h, bias: I.score > 15 ? 'bullish' : I.score < -15 ? 'bearish' : 'neutral', score: I.score, structure: I.structure, ema50: I.ema50, ema200: I.ema200, rsi: I.rsi && +I.rsi.toFixed(1), nearestRes: I.res[0]?.p, nearestSup: I.sup[0]?.p };
  } catch { return null; }
}

async function runAnalysis() {
  if (!S.candles.length) { toast('Load a chart first'); return; }
  const btn = $('#btnAnalyse'); btn.classList.add('busy'); btn.querySelector('.btn-label').textContent = 'Analysing…';
  const st = $('#aiStatus'); st.className = 'ai-status'; st.textContent = 'Reading structure, indicators, higher timeframe and news…';
  try {
    S.ind = analyseIndicators(S.candles);
    const htf = await htfInfo();
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
    if (setups.length < 3) {
      const extra = quant.setups.filter(q => !setups.some(s => Math.abs(s.entry - q.entry) < S.ind.atr * 0.3));
      setups = setups.concat(extra).slice(0, 4);
    }
    setups = setups.slice(0, 4);
    S.setups = setups;
    S.analysis = {
      bias: (result?.bias || quant.bias).toUpperCase(), score: isFinite(+result?.score) ? +result.score : quant.score,
      summary: result?.summary || autoSummary(S.ind, htf, quant), newsImpact: result?.newsImpact || '',
      keyLevels: result?.keyLevels, invalidation: result?.invalidation, by, htf
    };
    const RANK = { 'A+': 4, A: 3, B: 2, C: 1 };
    S.setups.forEach(s => s.grade = gradeOf(s, S.analysis));
    S.setups.sort((a, b) => (RANK[b.grade] - RANK[a.grade]) || (b.confidence - a.confidence));
    newSignalBatch();
    renderResult(S.analysis);
    if (setups.length) drawSetupLines(0);
    if (!st.classList.contains('err')) st.textContent = `Done · ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo' })} Colombo time`;
  } catch (e) {
    st.className = 'ai-status err'; st.textContent = 'Analysis error: ' + e.message;
  } finally {
    btn.classList.remove('busy'); btn.querySelector('.btn-label').textContent = 'Analyse with AI';
  }
}
function gradeOf(s, A) {
  let pts = 0;
  const rr = Math.abs(s.tp2 - s.entry) / Math.abs(s.entry - s.stopLoss);
  if (rr >= 2) pts += 2; else if (rr >= 1.5) pts += 1;
  if (s.confidence >= 70) pts += 2; else if (s.confidence >= 60) pts += 1;
  const htf = A.htf?.bias, d = s.direction;
  if (htf && ((htf === 'bullish' && d === 'long') || (htf === 'bearish' && d === 'short'))) pts += 2;
  else if (htf && htf !== 'neutral') pts -= 2;
  if ((A.bias.includes('BULL') && d === 'long') || (A.bias.includes('BEAR') && d === 'short')) pts += 1;
  return pts >= 6 ? 'A+' : pts >= 4 ? 'A' : pts >= 2 ? 'B' : 'C';
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
      <p class="why">${esc(s.reasoning)}</p>
      <div class="setup-act"><button data-show="${i}">Show</button><button class="go" data-trade="${i}" data-acc="demo">Take on Demo</button><button class="real" data-trade="${i}" data-acc="real">Took on Real</button></div>
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
      conf: s.confidence, grade: s.grade, entry: isM ? price : s.entry, sl: s.stopLoss, sl0: s.stopLoss, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
      prec: S.prec, status: isM ? 'active' : 'waiting', created: Date.now(), lastCheck: nowSec()
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
  S.sigStats.push({ symbol: g.symbol, market: g.market, dir: g.dir, type: g.type, name: g.name, grade: g.grade, win, t: Date.now() });
}
function processSignal(g, candles) {
  const sg = g.dir === 'long' ? 1 : -1;
  const events = [];
  for (const c of candles.filter(c => c.time + 60 >= g.lastCheck)) {
    if (g.status === 'waiting') {
      const fill = (g.type === 'BUY LIMIT' && c.low <= g.entry) || (g.type === 'BUY STOP' && c.high >= g.entry) ||
        (g.type === 'SELL LIMIT' && c.high >= g.entry) || (g.type === 'SELL STOP' && c.low <= g.entry);
      if (!fill) continue;
      g.status = 'active'; g.triggered = Date.now(); events.push('active');
    }
    const hit = lvl => sg > 0 ? c.high >= lvl : c.low <= lvl;
    const hitSL = sg > 0 ? c.low <= g.sl : c.high >= g.sl;
    let justHit = false;
    if (g.status === 'active') {
      if (hitSL) { g.status = 'sl'; recordStat(g, false); events.push('sl'); break; }
      if (hit(g.tp1)) { g.status = 'tp1'; g.sl = g.entry; recordStat(g, true); events.push('tp1'); justHit = true; }
    }
    if (g.status === 'tp1') {
      if (hit(g.tp2)) { g.status = 'tp2'; events.push('tp2'); break; }
      if (!justHit && (sg > 0 ? c.low <= g.sl : c.high >= g.sl)) { g.status = 'be'; events.push('be'); break; }
    }
  }
  if (g.status === 'waiting' && Date.now() - g.created > S.settings.auto.expiryBars * (TF_SEC[g.tf] || 900) * 1000) { g.status = 'expired'; events.push('expired'); }
  g.lastCheck = nowSec();
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
  const i = S.setups.findIndex(s => ['A+', 'A'].includes(s.grade) && s.confidence >= A.minConf);
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
  $('#sigRecord').textContent = st.length ? `AI record ${w}W/${st.length - w}L · ${(w / st.length * 100).toFixed(0)}%${symSt.length ? ` · this ${(sw / symSt.length * 100).toFixed(0)}%` : ''}` : 'no results yet';
  const sym = S.symbol.toUpperCase(), lb = latestBatch(S.market, sym);
  const list = S.signals.filter(g => (g.market === S.market && g.symbol === sym && g.batch === lb) || ['active', 'tp1'].includes(g.status))
    .sort((a, b) => b.batch - a.batch || a.idx - b.idx).slice(0, 10);
  const label = { waiting: 'WAITING', active: 'IN TRADE', tp1: 'TP1 ✓', tp2: 'TP2 ✓✓', sl: 'SL ✗', be: 'BE', expired: 'EXPIRED', replaced: 'REPLACED' };
  $('#sigList').innerHTML = list.length ? list.map(g => {
    const px = S.livePrices[g.market + '|' + g.symbol];
    const dist = px != null ? ` · now ${fmt(px, g.prec)}` : '';
    return `<li><span class="tag ${g.dir}">${g.dir === 'long' ? 'BUY' : 'SELL'}</span><span class="s-main">${esc(g.symbol)} #${g.idx + 1} ${g.grade ? `<span class="grade g${g.grade.replace('+', 'p')}">${g.grade}</span>` : ''}</span><span class="st ${g.status}">${label[g.status]}</span><span class="s-sub">${g.type} ${fmt(g.entry, g.prec)} · SL ${fmt(g.sl0, g.prec)} · TP ${fmt(g.tp1, g.prec)}/${fmt(g.tp2, g.prec)}${dist}</span></li>`;
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
  pendingTrade = { s, i };
  $('#tmAcc').value = accKey || S.settings.active;
  $('#tmEntry').value = +s.entry.toFixed(S.prec); $('#tmSL').value = +s.stopLoss.toFixed(S.prec);
  $('#tmTP1').value = +s.tp1.toFixed(S.prec); $('#tmTP2').value = +s.tp2.toFixed(S.prec);
  fillUnits(); $('#tmType').value = 'auto';
  $('#tradeModal').classList.remove('hidden');
}
function fillUnits() {
  const s = pendingTrade.s, z = sizingFor($('#tmAcc').value, s, S.market, S.symbol);
  $('#tmUnits').value = S.market === 'crypto' || S.market === 'forex' ? +z.units.toPrecision(5) : Math.floor(z.units);
  updateTmInfo();
}
function updateTmInfo() {
  if (!pendingTrade) return;
  const acc = $('#tmAcc').value;
  const entry = +$('#tmEntry').value, sl = +$('#tmSL').value, units = +$('#tmUnits').value, tp1 = +$('#tmTP1').value, tp2 = +$('#tmTP2').value;
  const f = quoteFactor(S.market, S.symbol, entry), cur = curOf(S.market), cs = contractSize(S.market, S.symbol);
  $('#tmTitle').textContent = `${ACC_LABEL[acc]} ${pendingTrade.s.direction === 'long' ? 'BUY' : 'SELL'} · ${S.symbol.toUpperCase()}`;
  $('#tmConfirm').textContent = acc === 'real' ? 'Track on Real' : 'Place on Demo';
  $('#tmInfo').innerHTML = `${ACC_LABEL[acc]} balance: <b>${money(S.accounts[acc][cur], cur)}</b><br>Risk if SL hits: <b class="down">${money(Math.abs(entry - sl) * units * f, cur)}</b><br>Profit TP1 (half) + TP2 (half): <b class="up">${money((Math.abs(tp1 - entry) + Math.abs(tp2 - entry)) * units / 2 * f, cur)}</b>${cs > 1 ? `<br>= ${(units / cs).toFixed(2)} lots` : ''}${acc === 'real' ? '<br><span style="color:var(--gold)">Place this trade at your broker with the same levels. Pryme tracks it live and updates your Real balance estimate.</span>' : ''}`;
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
    entry: isM ? price : entry, sl, tp1, tp2, units, remaining: units, cur: curOf(S.market),
    factor: quoteFactor(S.market, S.symbol, entry), status: isM ? 'open' : 'pending', created: Date.now(), opened: isM ? Date.now() : null,
    realized: 0, tp1Hit: false, lastCheck: nowSec(), prec: S.prec, name: s.name, auto, batch: S.batch
  };
  S.accounts[accKey].positions.push(pos); saveAccounts();
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
  if (['tp1', 'tp2', 'sl'].includes(kind)) notify(`Pryme ${ACC_LABEL[pos.acc]}: ${pos.symbol} ${reason}`, `${pnl >= 0 ? '+' : ''}${money(pnl, pos.cur)}`);
  const A = S.settings.auto;
  if ((kind === 'tp1' && A.trigger === 'tp1') || ((kind === 'tp2' || kind === 'be') && A.trigger === 'tp2') || (kind === 'sl' && A.onSL))
    requestNext(pos.batch, pos.market, pos.symbol, pos.tf, `${ACC_LABEL[pos.acc]} ${pos.symbol} ${reason}`);
}
function processPosition(pos, candles) {
  const sg = pos.dir === 'long' ? 1 : -1;
  for (const c of candles.filter(c => c.time + 60 >= pos.lastCheck)) {
    if (pos.status === 'pending') {
      const fill = (pos.type === 'BUY LIMIT' && c.low <= pos.entry) || (pos.type === 'BUY STOP' && c.high >= pos.entry) ||
        (pos.type === 'SELL LIMIT' && c.high >= pos.entry) || (pos.type === 'SELL STOP' && c.low <= pos.entry);
      if (!fill) continue;
      pos.status = 'open'; pos.opened = Date.now();
      addLog(`${ACC_LABEL[pos.acc]} ${pos.symbol} ${pos.type} filled at ${fmt(pos.entry, pos.prec)}.`);
    }
    if (pos.status !== 'open') break;
    const hitSL = sg > 0 ? c.low <= pos.sl : c.high >= pos.sl;
    if (hitSL) { closePart(pos, pos.sl, pos.remaining, pos.tp1Hit ? 'Break-even stop' : 'Stop loss hit'); break; }
    if (!pos.tp1Hit && (sg > 0 ? c.high >= pos.tp1 : c.low <= pos.tp1)) { pos.tp1Hit = true; closePart(pos, pos.tp1, pos.units / 2, 'TP1 hit (half closed, SL → entry)'); pos.sl = pos.entry; }
    if (pos.status === 'open' && (sg > 0 ? c.high >= pos.tp2 : c.low <= pos.tp2)) { closePart(pos, pos.tp2, pos.remaining, 'TP2 hit'); break; }
  }
  pos.lastCheck = nowSec();
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
          candles = (await fetchCandles(market, symbol, '1m', 10)).candles || [];
        }
      } catch { continue; }
      if (!candles.length) continue;
      S.livePrices[k] = candles[candles.length - 1].close;
      sigs.filter(g => g.market + '|' + g.symbol === k).forEach(g => processSignal(g, candles));
      pos.filter(p => p.market + '|' + p.symbol === k).forEach(p => processPosition(p, candles));
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
  const fl = { USD: 0, LKR: 0 };
  d.positions.filter(p => p.status === 'open').forEach(p => {
    const px = S.livePrices[p.market + '|' + p.symbol]; if (px == null) return;
    fl[p.cur] += (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor;
  });
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
    t.innerHTML = '<tr><th>Symbol</th><th>Side</th><th>Status</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Size</th><th>Now</th><th>P/L</th><th></th></tr>' + d.positions.map(p => {
      const px = S.livePrices[p.market + '|' + p.symbol];
      const pl = p.status === 'open' && px != null ? (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor + p.realized : p.realized;
      return `<tr><td>${esc(p.symbol)} <small style="color:var(--dim)">${p.tf}</small>${p.auto ? ' <small class="autotag">AUTO</small>' : ''}</td><td class="${p.dir === 'long' ? 'up' : 'down'}">${p.dir === 'long' ? 'BUY' : 'SELL'}</td><td>${p.status === 'pending' ? esc(p.type) : p.tp1Hit ? 'Open · TP1 ✓' : 'Open'}</td><td>${fmt(p.entry, p.prec)}</td><td>${fmt(p.sl, p.prec)}</td><td>${fmt(p.tp1, p.prec)}</td><td>${fmt(p.tp2, p.prec)}</td><td>${(+p.remaining).toPrecision(4)}</td><td>${px != null ? fmt(px, p.prec) : '…'}</td><td class="${pl >= 0 ? 'up' : 'down'}">${money(pl, p.cur)}</td><td><button class="x" data-close-pos="${p.id}">${p.status === 'pending' ? 'Cancel' : 'Close'}</button></td></tr>`;
    }).join('');
  } else {
    if (!d.history.length) { t.innerHTML = '<tr><td style="color:var(--dim);padding:18px 8px">No closed trades yet.</td></tr>'; return; }
    t.innerHTML = '<tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Result</th><th>P/L</th></tr>' + d.history.slice(0, 100).map(h => `<tr><td>${new Date(h.closed).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(h.symbol)}</td><td class="${h.dir === 'long' ? 'up' : 'down'}">${h.dir === 'long' ? 'BUY' : 'SELL'}</td><td>${fmt(h.entry, h.prec)}</td><td>${fmt(h.exit, h.prec)}</td><td>${esc(h.reason)}</td><td class="${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}${money(h.pnl, h.cur)}</td></tr>`).join('');
  }
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
  $('#symbolList').innerHTML = PICKS[m].map(s => `<option value="${s}">`).join('');
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
  $('#symbolInput').onchange = e => { if (PICKS[S.market].includes(e.target.value.toUpperCase())) setSymbol(e.target.value); };
  $('.chart-tabs').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };

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
  $('#riskInput').value = S.settings.riskPct;
  $('#riskInput').oninput = e => { S.settings.riskPct = Math.max(0.1, Math.min(10, +e.target.value || 1)); saveSettings(); if (S.analysis) renderResult(S.analysis); };
  $('#btnAnalyse').onclick = runAnalysis;

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
  $('#posTable').onclick = e => { const b = e.target.closest('[data-close-pos]'); if (b) manualClose(b.dataset.closePos); };
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

/* ---------------- boot ---------------- */
initChart();
wire();
$$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === S.tf));
setAcctView(S.acctView);
setMarket(S.market).then(renderSignals);
renderLog(); renderSignals(); renderAcctCard();
setInterval(monitor, 8000);

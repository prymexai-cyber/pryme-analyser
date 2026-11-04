/* ============================================================
   PRYME QUANT — full market analysis (29 methods)
   Each method gives a vote: bullish (+), bearish (−) or neutral, with a short reason.
   Pryme only marks a setup TRADE when most methods agree with its direction.
   Methods without free data (options flow) say so honestly instead of guessing.
   ============================================================ */
'use strict';
const DEEP_WEIGHTS = {
  'Technical': 1.2, 'Fundamental': 0.6, 'Price Action': 1, 'Market Structure': 1.4, 'Smart Money Concepts': 1.2, 'ICT Concepts': 1,
  'Order Flow': 0.8, 'Volume Profile': 0.8, 'Volume Spread (VSA)': 0.6, 'Liquidity': 1, 'Supply & Demand': 1, 'Support & Resistance': 1,
  'Multi-Timeframe': 1.6, 'Fibonacci': 0.7, 'Elliott Wave': 0.4, 'Wyckoff': 0.6, 'Quantitative': 0.8, 'Statistical': 0.9,
  'Algorithmic': 1, 'Sentiment': 0.6, 'Intermarket': 0.7, 'Macroeconomic': 0.5, 'News & Events': 0.8, 'Volatility': 0.3,
  'Correlation': 0.4, 'Options Flow': 0, 'Market Profile': 0.7, 'Seasonal': 0.3, 'Risk Management': 0, 'Portfolio': 0
};
const DEEP_GROUPS = {
  'Price & structure': ['Technical', 'Price Action', 'Market Structure', 'Support & Resistance', 'Multi-Timeframe', 'Fibonacci', 'Elliott Wave'],
  'Smart money & liquidity': ['Smart Money Concepts', 'ICT Concepts', 'Liquidity', 'Supply & Demand', 'Wyckoff'],
  'Volume & order flow': ['Order Flow', 'Volume Profile', 'Volume Spread (VSA)', 'Market Profile'],
  'Quant & statistics': ['Quantitative', 'Statistical', 'Algorithmic', 'Volatility', 'Seasonal', 'Correlation'],
  'Fundamentals & news': ['Fundamental', 'Macroeconomic', 'News & Events', 'Sentiment', 'Intermarket', 'Options Flow'],
  'Risk': ['Risk Management', 'Portfolio']
};

function newsSentiment(items) {
  const POS = /\b(rall(y|ies)|surge|soar|jump|gain|rise|rises|bull|record high|beat|upgrade|strong|optimis|rebound|inflow|approve|cut rates?|rate cut|easing|buy)\b/i;
  const NEG = /\b(fall|falls|drop|plunge|slump|crash|tumble|bear|loss|losses|miss|downgrade|weak|fear|sell-?off|outflow|hike|tighten|ban|lawsuit|probe|war|tariff|recession|default)\b/i;
  let s = 0, n = 0;
  (items || []).slice(0, 15).forEach(x => { const t = x.title || ''; const p = POS.test(t), q = NEG.test(t); if (p !== q) { s += p ? 1 : -1; n++; } });
  return { score: n ? s / n : 0, n };
}
function corr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 10) return null;
  a = a.slice(-n); b = b.slice(-n);
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
const rets = cs => cs.slice(1).map((c, i) => Math.log(c.close / cs[i].close));
function profile(cs, weightByVol) {
  const lo = Math.min(...cs.map(x => x.low)), hi = Math.max(...cs.map(x => x.high)), N = 48, bw = (hi - lo) / N || 1, bins = new Array(N).fill(0);
  cs.forEach(x => { const w = weightByVol ? (x.volume || 1) : 1; const a = Math.max(0, Math.floor((x.low - lo) / bw)), b = Math.min(N - 1, Math.floor((x.high - lo) / bw)); for (let k = a; k <= b; k++) bins[k] += w / (b - a + 1); });
  const tot = bins.reduce((x, y) => x + y, 0); let poc = bins.indexOf(Math.max(...bins)), l = poc, h = poc, acc = bins[poc];
  while (acc < tot * 0.7 && (l > 0 || h < N - 1)) { const nl = l > 0 ? bins[l - 1] : -1, nh = h < N - 1 ? bins[h + 1] : -1; if (nh >= nl) acc += bins[++h]; else acc += bins[--l]; }
  return { poc: lo + (poc + 0.5) * bw, val: lo + l * bw, vah: lo + (h + 1) * bw };
}

async function deepAnalysis(htf, htf2) {
  const cs = S.candles, I = S.ind; if (!cs.length || !I) return null;
  const n = cs.length, p = I.price, a = I.atr, R = [];
  const add = (method, v, note) => R.push({ method, v: Math.max(-1, Math.min(1, v)), note });
  const dir = v => v > 0.15 ? 'bull' : v < -0.15 ? 'bear' : 'neutral';
  const bars = cs.slice(-200);

  // 1 Technical
  add('Technical', I.score / 60, `Composite of EMA 20/50/200, RSI ${I.rsi?.toFixed(0)}, MACD ${I.macdHist > 0 ? 'positive' : 'negative'}, ADX ${I.adx ? I.adx.adx.toFixed(0) : '—'} → score ${I.score}`);
  // 3 Price action
  const pa = (I.patterns || []).reduce((s, x) => s + (/^Bullish/.test(x) ? 1 : /^Bearish/.test(x) ? -1 : 0), 0) + (I.conf2?.bull ? 0.7 : 0) - (I.conf2?.bear ? 0.7 : 0);
  add('Price Action', pa / 1.5, (I.patterns || []).length ? I.patterns.join(', ') : (I.conf2?.bull ? 'Last closed candle confirms buyers' : I.conf2?.bear ? 'Last closed candle confirms sellers' : 'No clear candle signal'));
  // 4 Market structure
  const ms = /^bullish/.test(I.structure) ? 1 : /^bearish/.test(I.structure) ? -1 : 0;
  add('Market Structure', ms * 0.8 + (I.bos ? (/bullish/.test(I.bos) ? 0.3 : -0.3) : 0), `${I.structure}${I.bos ? ' · ' + I.bos : ''}`);
  // 5 SMC
  const K = I.keys || {};
  const legMid = (K.rangeHigh + K.rangeLow) / 2;
  const smc = (K.sweepLong ? 0.6 : 0) - (K.sweepShort ? 0.6 : 0) + (p < legMid ? 0.3 : -0.3) * (ms || 1) * 0.5;
  add('Smart Money Concepts', smc, `${K.sweepLong ? 'Sell-side liquidity swept & reclaimed · ' : ''}${K.sweepShort ? 'Buy-side liquidity swept & rejected · ' : ''}price in ${p < legMid ? 'discount' : 'premium'} of the range · ${(I.zones || []).length} order-block/FVG zones`);
  // 6 ICT
  const h = new Date().getUTCHours();
  const kill = S.market === 'forex' ? (h >= 7 && h < 10 ? 'London killzone' : h >= 12 && h < 15 ? 'New York killzone' : null) : null;
  const leg = cs.slice(-80), lo80 = Math.min(...leg.map(x => x.low)), hi80 = Math.max(...leg.map(x => x.high));
  const pos80 = (p - lo80) / ((hi80 - lo80) || 1);
  const ict = ms > 0 ? (pos80 < 0.5 ? 0.6 : -0.1) : ms < 0 ? (pos80 > 0.5 ? -0.6 : 0.1) : 0;
  add('ICT Concepts', ict, `Price at ${(pos80 * 100).toFixed(0)}% of the dealing range (${pos80 < 0.38 ? 'deep discount / OTE for buys' : pos80 > 0.62 ? 'premium / OTE for sells' : 'equilibrium'})${kill ? ' · ' + kill + ' active' : ''}`);
  // 7 Order flow (delta proxy from where each bar closes inside its range × volume)
  const delta = bars.slice(-30).map(x => (x.volume || 1) * (((x.close - x.low) - (x.high - x.close)) / ((x.high - x.low) || 1)));
  const cvd = delta.reduce((s, x) => s + x, 0), absd = delta.reduce((s, x) => s + Math.abs(x), 0) || 1;
  const pr = (p - cs[n - 31].close) / a;
  add('Order Flow', cvd / absd * 1.5, `Buy/sell pressure (delta proxy, 30 bars): ${cvd >= 0 ? 'buyers' : 'sellers'} ${(Math.abs(cvd) / absd * 100).toFixed(0)}%${Math.sign(cvd) !== Math.sign(pr) && Math.abs(pr) > 1 ? ' · divergence with price' : ''}`);
  // 8 Volume profile
  const vp = profile(bars, true);
  add('Volume Profile', p > vp.vah ? 0.5 : p < vp.val ? -0.5 : (p > vp.poc ? 0.15 : -0.15), `POC ${fmt(vp.poc)} · value area ${fmt(vp.val)}–${fmt(vp.vah)} · price ${p > vp.vah ? 'accepted above value' : p < vp.val ? 'below value' : 'inside value'}`);
  // 27 Market profile (time at price)
  const tp = profile(bars, false);
  add('Market Profile', p > tp.vah ? 0.4 : p < tp.val ? -0.4 : 0, `TPO value area ${fmt(tp.val)}–${fmt(tp.vah)}, POC ${fmt(tp.poc)}`);
  // 9 VSA
  const avgV = bars.slice(-50).reduce((s, x) => s + (x.volume || 0), 0) / 50 || 1, avgR = bars.slice(-50).reduce((s, x) => s + (x.high - x.low), 0) / 50 || 1;
  let vsa = 0, vsaNote = 'No notable effort/result signal';
  bars.slice(-8).forEach(x => {
    const v = (x.volume || 0) / avgV, r = (x.high - x.low) / avgR, cl = (x.close - x.low) / ((x.high - x.low) || 1);
    if (v > 1.6 && r > 1.2 && cl > 0.7) { vsa += 0.4; vsaNote = 'High-volume up bar closing strong (demand)'; }
    if (v > 1.6 && r > 1.2 && cl < 0.3) { vsa -= 0.4; vsaNote = 'High-volume down bar closing weak (supply)'; }
    if (v > 1.8 && r < 0.8) { vsa += x.close < x.open ? 0.3 : -0.3; vsaNote = x.close < x.open ? 'Stopping volume on a down bar (absorption)' : 'Heavy volume, little progress up (selling into strength)'; }
    if (v < 0.6 && r < 0.7) { vsa += cl > 0.5 ? 0.1 : -0.1; }
  });
  add('Volume Spread (VSA)', vsa, vsaNote);
  // 10 Liquidity
  const eqh = (K.eqh || []).filter(v => v > p), eql = (K.eql || []).filter(v => v < p);
  add('Liquidity', (K.sweepLong ? 0.5 : 0) - (K.sweepShort ? 0.5 : 0) + (eqh.length ? 0.15 : 0) - (eql.length ? 0.15 : 0), `Buy-side liquidity above: ${eqh.map(v => fmt(v)).join(', ') || 'none'} · sell-side below: ${eql.map(v => fmt(v)).join(', ') || 'none'}`);
  // 11 Supply & demand
  const dz = (I.zones || []).filter(z => z.side === 'long'), sz = (I.zones || []).filter(z => z.side === 'short');
  const dS = dz[0] ? dz[0].score / (1 + Math.abs(p - dz[0].hi) / a) : 0, sS = sz[0] ? sz[0].score / (1 + Math.abs(sz[0].lo - p) / a) : 0;
  add('Supply & Demand', (dS - sS) / 3, `Nearest demand ${dz[0] ? fmt(dz[0].lo) + '–' + fmt(dz[0].hi) : '—'} · nearest supply ${sz[0] ? fmt(sz[0].lo) + '–' + fmt(sz[0].hi) : '—'}`);
  // 12 S/R
  const ds = I.sup?.[0] ? (p - I.sup[0].p) / a : 9, dr = I.res?.[0] ? (I.res[0].p - p) / a : 9;
  add('Support & Resistance', ds < 1 ? 0.5 : dr < 1 ? -0.5 : (dr - ds) / 10, `Support ${I.sup?.[0] ? fmt(I.sup[0].p) : '—'} (${ds.toFixed(1)} ATR) · resistance ${I.res?.[0] ? fmt(I.res[0].p) : '—'} (${dr.toFixed(1)} ATR)`);
  // 13 MTF
  const bv = b => b === 'bullish' ? 1 : b === 'bearish' ? -1 : 0;
  add('Multi-Timeframe', (bv(htf?.bias) * 0.6 + bv(htf2?.bias) * 0.4) + ms * 0.2, `${S.tf}: ${I.structure.split(' ')[0]} · ${htf ? htf.timeframe + ': ' + htf.bias : 'HTF —'} · ${htf2 ? htf2.timeframe + ': ' + htf2.bias : '2nd HTF —'}`);
  // 14 Fibonacci
  const upLeg = ms >= 0, fr = upLeg ? (hi80 - p) / ((hi80 - lo80) || 1) : (p - lo80) / ((hi80 - lo80) || 1);
  add('Fibonacci', fr >= 0.5 && fr <= 0.79 ? (upLeg ? 0.6 : -0.6) : fr < 0.236 ? (upLeg ? -0.2 : 0.2) : 0, `Retracement of the last ${upLeg ? 'up' : 'down'}-leg: ${(fr * 100).toFixed(0)}% ${fr >= 0.618 && fr <= 0.786 ? '(golden pocket / OTE)' : ''}`);
  // 15 Elliott wave (rough swing count)
  const sw = swings(cs.slice(-250), 4), seq = [...sw.hi.map(x => ({ ...x, k: 'H' })), ...sw.lo.map(x => ({ ...x, k: 'L' }))].sort((x, y) => x.i - y.i).slice(-9);
  let up = 0, down = 0; for (let i = 2; i < seq.length; i++) { if (seq[i].k === seq[i - 2].k) { if (seq[i].p > seq[i - 2].p) up++; else down++; } }
  const ew = up >= 4 && ms > 0 ? (pos80 > 0.85 ? -0.3 : 0.3) : down >= 4 && ms < 0 ? (pos80 < 0.15 ? 0.3 : -0.3) : 0;
  add('Elliott Wave', ew, up >= 4 ? `Impulsive up-sequence (${up} higher swings)${pos80 > 0.85 ? ' — possibly late wave 5, beware' : ' — buy wave 2/4 pullbacks'}` : down >= 4 ? `Impulsive down-sequence (${down} lower swings)${pos80 < 0.15 ? ' — possibly late wave 5' : ' — sell wave 2/4 rallies'}` : 'Corrective / unclear count (rough estimate)');
  // 16 Wyckoff
  const r60 = cs.slice(-60), rH = Math.max(...r60.slice(0, -5).map(x => x.high)), rL = Math.min(...r60.slice(0, -5).map(x => x.low));
  const ranging = (rH - rL) < a * 8, last5 = cs.slice(-5);
  const spring = ranging && last5.some(x => x.low < rL) && p > rL, upthrust = ranging && last5.some(x => x.high > rH) && p < rH;
  add('Wyckoff', spring ? 0.7 : upthrust ? -0.7 : 0, spring ? 'Spring below the trading range (accumulation sign)' : upthrust ? 'Upthrust above the trading range (distribution sign)' : ranging ? 'Trading range — waiting for spring or upthrust' : 'Trending phase (mark-up / mark-down)');
  // 17 Quantitative
  const c50 = cs.slice(-50).map(x => x.close), m50 = c50.reduce((s, x) => s + x, 0) / 50, sd50 = Math.sqrt(c50.reduce((s, x) => s + (x - m50) ** 2, 0) / 50) || 1, z = (p - m50) / sd50;
  const mom = (p - cs[n - 21].close) / (a * 4);
  add('Quantitative', Math.abs(z) > 2.2 ? -Math.sign(z) * 0.5 : mom * 0.6, `Z-score vs 50-bar mean ${z.toFixed(2)} ${Math.abs(z) > 2.2 ? '(stretched — mean reversion risk)' : ''} · 20-bar momentum ${(mom * 4).toFixed(1)} ATR`);
  // 18 Statistical: how often did price go up 10 bars later when the trend looked like now?
  const e20 = ema(cs.map(x => x.close), 20), e50 = ema(cs.map(x => x.close), 50); let same = 0, upCount = 0;
  const nowUp = e20[n - 1] > e50[n - 1];
  for (let i = 60; i < n - 10; i++) if (e20[i] && e50[i] && (e20[i] > e50[i]) === nowUp) { same++; if (cs[i + 10].close > cs[i].close) upCount++; }
  const prob = same ? upCount / same : 0.5;
  add('Statistical', (prob - 0.5) * 3, `On this chart, when EMA20 ${nowUp ? '>' : '<'} EMA50, price was higher 10 bars later ${(prob * 100).toFixed(0)}% of the time (${same} samples)`);
  // 19 Algorithmic: the quant engine + checklist on the current bar
  const q = quantSetups(I, htf?.bias);
  const okSet = q.setups.map(x => ({ ...x })); okSet.forEach(x => { proAdjust(x); x.grade = gradeOf(x, { bias: q.bias, htf, htf2 }); });
  const good = okSet.filter(x => x.ok);
  add('Algorithmic', good.length ? (good[0].direction === 'long' ? 0.6 : -0.6) : 0, good.length ? `Rules engine has ${good.length} valid ${good[0].direction === 'long' ? 'BUY' : 'SELL'} setup(s)${S.lastBacktest ? ` · last backtest ${S.lastBacktest}` : ''}` : 'Rules engine: no setup passes the checklist right now');
  // 20 Sentiment (+ crypto fear & greed)
  const ns = newsSentiment(S.news);
  let fg = null; if (S.market === 'crypto') { try { fg = await getJSON('/api/sentiment'); } catch { } }
  const fgv = fg?.value != null ? (fg.value - 50) / 50 : 0;
  add('Sentiment', ns.score * 0.6 + (fg?.value != null ? (Math.abs(fgv) > 0.6 ? -fgv * 0.5 : fgv * 0.3) : 0), `News tone ${ns.score > 0.15 ? 'positive' : ns.score < -0.15 ? 'negative' : 'mixed'} (${ns.n} headlines)${fg?.value != null ? ` · Fear & Greed ${fg.value} (${fg.label})${Math.abs(fgv) > 0.6 ? ' — extreme, contrarian' : ''}` : ''}`);
  // 2 Fundamental
  const fq = S.meta?.quote;
  let fv = 0, fnote = 'Fundamentals read from today’s news and the economic calendar';
  if (fq && fq.wk52High && fq.wk52Low && fq.last) { const pos = (fq.last - fq.wk52Low) / ((fq.wk52High - fq.wk52Low) || 1); fv = pos < 0.3 ? 0.3 : pos > 0.9 ? -0.2 : 0.1; fnote = `52-week range ${fmt(fq.wk52Low)}–${fmt(fq.wk52High)} (price at ${(pos * 100).toFixed(0)}%)${fq.marketCap ? ' · market cap ' + Number(fq.marketCap).toLocaleString('en-US') : ''}`; }
  else fv = ns.score * 0.4;
  add('Fundamental', fv, fnote);
  // 21 Intermarket + 25 correlation
  let im = 0, imNote = 'No strong intermarket driver', cNote = 'Not enough data';
  try {
    const sym = S.symbol.toUpperCase();
    const ref = S.market === 'crypto' ? ['forex', 'NAS100'] : (S.market === 'forex' || S.market === 'stock') ? ['forex', 'DXY'] : null;
    if (ref && !(ref[1] === 'DXY' && sym === 'DXY')) {
      const [mine, other] = await Promise.all([fetchCandles(S.market, S.symbol, '1d', 120), fetchCandles(ref[0], ref[1], '1d', 120)]);
      const mc = mine.candles || [], oc = other.candles || [];
      const map = new Map(oc.map(x => [Math.floor(x.time / 86400), x.close]));
      const pairs = mc.filter(x => map.has(Math.floor(x.time / 86400))).map(x => [x.close, map.get(Math.floor(x.time / 86400))]);
      if (pairs.length > 30) {
        const ra = pairs.slice(1).map((x, i) => Math.log(x[0] / pairs[i][0])), rb = pairs.slice(1).map((x, i) => Math.log(x[1] / pairs[i][1]));
        const cr = corr(ra.slice(-60), rb.slice(-60));
        const oT = (pairs[pairs.length - 1][1] - pairs[pairs.length - 11][1]) / pairs[pairs.length - 11][1];
        if (cr != null) { im = Math.sign(cr) * Math.sign(oT) * Math.min(1, Math.abs(cr)) * 0.7; imNote = `${ref[1]} ${oT >= 0 ? 'up' : 'down'} ${(oT * 100).toFixed(1)}% in 10 days; ${sym} moves ${cr >= 0 ? 'with' : 'against'} it`; cNote = `60-day correlation with ${ref[1]}: ${cr.toFixed(2)}`; }
      }
    }
  } catch { }
  add('Intermarket', im, imNote);
  add('Correlation', 0, cNote);
  // 22 Macro + 23 news & events
  const cal = (S.calendar || []).filter(e => currenciesOf(S.market, S.symbol).includes(e.cur) && e.t > Date.now() && e.t < Date.now() + 3 * 86400e3);
  add('Macroeconomic', 0, cal.length ? `Upcoming: ${cal.slice(0, 3).map(e => `${e.cur} ${e.title}`).join(' · ')}` : 'No major scheduled events for this symbol in the next 3 days');
  const nn = newsNear(S.market, S.symbol, 60, 30);
  add('News & Events', 0, nn.length ? `⚠ ${nn[0].cur} ${nn[0].title} within the hour — avoid new entries` : 'No high-impact news within ±1 hour');
  // 24 Volatility
  const atrs = atr(cs).filter(Boolean), aPct = atrs.filter(x => x < a).length / atrs.length;
  const B = bollinger(cs.map(x => x.close)).filter(Boolean), bw = B.map(x => (x.up - x.lo) / x.mid), bwNow = bw[bw.length - 1], bwPct = bw.filter(x => x < bwNow).length / bw.length;
  add('Volatility', 0, `ATR at the ${(aPct * 100).toFixed(0)}th percentile${bwPct < 0.15 ? ' · Bollinger squeeze — breakout likely' : bwPct > 0.85 ? ' · very wide bands — use wider stops / smaller size' : ''}`);
  // 26 Options flow — honest
  add('Options Flow', 0, 'Not available: no free options-flow data feed (shown for completeness, not counted)');
  // 28 Seasonal (hour-of-day / day-of-week on this chart)
  const hr = new Date().getUTCHours(), dw = new Date().getUTCDay(); let hs = 0, hn = 0;
  for (let i = 1; i < n; i++) { const d = new Date(cs[i].time * 1000); if (TF_SEC[S.tf] >= 86400 ? d.getUTCDay() === dw : d.getUTCHours() === hr) { hs += Math.sign(cs[i].close - cs[i].open); hn++; } }
  add('Seasonal', hn > 8 ? (hs / hn) * 0.8 : 0, hn > 8 ? `This ${TF_SEC[S.tf] >= 86400 ? 'weekday' : 'hour (UTC ' + hr + ':00)'} closed up ${(((hs / hn) + 1) / 2 * 100).toFixed(0)}% of the time (${hn} bars)` : 'Not enough history');
  // 29 Risk + portfolio
  const g = riskGuard(); const accO = ACC(), cur = curOf(S.market);
  const openRisk = accO.positions.filter(x => x.status === 'open' && x.sl != null).reduce((s, x) => s + Math.abs(x.entry - x.sl) * x.remaining * x.factor, 0);
  add('Risk Management', 0, g.block ? '⛔ ' + g.why : `Risk per trade ${S.settings.riskPct}% · open risk ${money(openRisk, cur)} (${(openRisk / (accO[cur] || 1) * 100).toFixed(1)}% of balance)`);
  const usd = accO.positions.filter(x => x.status === 'open').reduce((s, x) => { const c = currenciesOf(x.market, x.symbol); const usdSide = c[0] === 'USD' ? 1 : c[1] === 'USD' ? -1 : (x.market !== 'cse' ? -1 : 0); return s + (x.dir === 'long' ? usdSide : -usdSide); }, 0);
  add('Portfolio', 0, `${accO.positions.filter(x => x.status === 'open').length} open positions · net USD exposure ${usd > 0 ? 'long' : usd < 0 ? 'short' : 'flat'}${Math.abs(usd) >= 3 ? ' — heavily concentrated, consider smaller size' : ''}`);

  // combine
  let num = 0, den = 0;
  R.forEach(r => { const w = DEEP_WEIGHTS[r.method] ?? 0.5; num += r.v * w; den += w; r.dir = DEEP_WEIGHTS[r.method] === 0 ? 'info' : dir(r.v); });
  const total = den ? num / den : 0;
  const voters = R.filter(r => r.dir === 'bull' || r.dir === 'bear');
  const bull = voters.filter(r => r.dir === 'bull').length, bear = voters.filter(r => r.dir === 'bear').length;
  const side = total > 0.05 ? 'long' : total < -0.05 ? 'short' : null;
  // agreement only counts when enough methods actually vote (at least 6 bullish/bearish)
  const agree = side && bull + bear >= 6 ? (side === 'long' ? bull : bear) / (bull + bear) : 0;
  const out = { at: Date.now(), list: R, total, bull, bear, neutral: R.length - bull - bear, side, agree, blocked: g.block || nn.length > 0 };
  out.forAI = { overall: side ? `${side === 'long' ? 'BULLISH' : 'BEARISH'} ${(agree * 100).toFixed(0)}% agreement (${bull} bull / ${bear} bear methods)` : 'NO CLEAR EDGE', methods: R.map(r => `${r.method}: ${r.dir} — ${r.note}`) };
  return out;
}

function renderDeep() {
  const D = S.deep, box = $('#deepBody'); if (!box) return;
  if (!D) return;
  $('#deepSub').textContent = new Date(D.at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' }) + ' · ' + S.symbol.toUpperCase() + ' ' + S.tf;
  const pct = Math.round(D.agree * 100), col = D.side === 'long' ? 'up' : D.side === 'short' ? 'down' : '';
  const chip = r => `<span class="dv ${r.dir}">${{ bull: '▲ Bullish', bear: '▼ Bearish', neutral: '• Neutral', info: 'ℹ Info' }[r.dir]}</span>`;
  box.innerHTML = `
    <div class="deep-top">
      <div class="deep-score ${col}"><b>${D.side ? (D.side === 'long' ? 'BUY BIAS' : 'SELL BIAS') : 'NO EDGE'}</b><span>${D.side ? (D.bull + D.bear >= 6 ? pct + '% of voting methods agree' : 'too few methods give a direction') : 'methods disagree'}</span></div>
      <div class="deep-bar"><i class="b" style="width:${D.bull / (D.bull + D.bear + D.neutral) * 100}%"></i><i class="n" style="width:${D.neutral / (D.bull + D.bear + D.neutral) * 100}%"></i><i class="s" style="width:${D.bear / (D.bull + D.bear + D.neutral) * 100}%"></i></div>
      <div class="deep-cnt"><span class="up">${D.bull} bullish</span> · <span>${D.neutral} neutral / info</span> · <span class="down">${D.bear} bearish</span></div>
      ${D.blocked ? '<div class="pro-banner stop">⛔ Risk / news check says wait — no new trades right now.</div>' : D.side && pct >= 70 ? `<div class="pro-banner go">✓ Strong agreement — only ${D.side === 'long' ? 'BUY' : 'SELL'} setups are marked TRADE.</div>` : '<div class="pro-banner wait">⏸ Methods don’t agree enough — Pryme waits for a cleaner chart.</div>'}
    </div>
    ${Object.entries(DEEP_GROUPS).map(([g, ms]) => `<div class="deep-group"><div class="eq-head">${g}</div>${ms.map(m => D.list.find(r => r.method === m)).filter(Boolean).map(r => `<div class="deep-row"><div class="dm"><b>${r.method}</b><small>${esc(r.note)}</small></div>${chip(r)}</div>`).join('')}</div>`).join('')}`;
}

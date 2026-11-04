/* ============================================================
   PRYME QUANT — chart tools
   - light / dark chart (TradingView colours)
   - drawing tools: trend line, horizontal line, ray, rectangle, Fibonacci, text, eraser
   - indicators panel: EMA 20/50, EMA 200, MSNR key levels (D1/H4/H1), smart-money zones,
     trading sessions, Bollinger Bands, VWAP, volume, RSI, MACD, previous-day high/low
   ============================================================ */
'use strict';
(() => {
  if (typeof chart === 'undefined' || !chart) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#drawLayer');

  /* ---------------- theme ---------------- */
  const THEMES = {
    light: { bg: '#ffffff', text: '#131722', grid: 'rgba(42,46,57,0.07)', border: '#e0e3eb', cross: '#9598a1', crossLbl: '#131722' },
    dark: { bg: '#131722', text: '#b2b5be', grid: 'rgba(42,46,57,0.6)', border: '#2a2e39', cross: '#758696', crossLbl: '#4c525e' }
  };
  function applyTheme(name, save = true) {
    const t = THEMES[name] || THEMES.light;
    chart.applyOptions({
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border },
      crosshair: { vertLine: { color: t.cross, labelBackgroundColor: t.crossLbl }, horzLine: { color: t.cross, labelBackgroundColor: t.crossLbl } }
    });
    document.body.dataset.chart = name;
    if (save) { S.settings.chartTheme = name; saveSettings(); }
    try { if (typeof tvw !== 'undefined' && tvw && tvw.changeTheme) tvw.changeTheme(name === 'light' ? 'Light' : 'Dark'); } catch { }
    render();
  }

  /* ---------------- coordinates ---------------- */
  const tfs = () => TF_SEC[S.tf] || 900;
  function idxOfTime(t) {
    const cs = S.candles; if (!cs.length) return null;
    const n = cs.length;
    if (t >= cs[n - 1].time) return n - 1 + (t - cs[n - 1].time) / tfs();
    if (t <= cs[0].time) return (t - cs[0].time) / tfs();
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cs[m].time <= t) lo = m; else hi = m; }
    return lo + (t - cs[lo].time) / ((cs[hi].time - cs[lo].time) || 1);
  }
  function timeOfIdx(i) {
    const cs = S.candles, n = cs.length; if (!n) return null;
    if (i >= n - 1) return cs[n - 1].time + (i - (n - 1)) * tfs();
    if (i <= 0) return cs[0].time + i * tfs();
    const lo = Math.floor(i); return cs[lo].time + (i - lo) * (cs[lo + 1].time - cs[lo].time);
  }
  const xOf = t => { const i = idxOfTime(t); return i == null ? null : chart.timeScale().logicalToCoordinate(i); };
  const yOf = p => candleS.priceToCoordinate(p);
  const width = () => $('#chart').clientWidth - chart.priceScale('right').width();
  const height = () => $('#chart').clientHeight - (chart.timeScale().height ? chart.timeScale().height() : 26);
  function ptFromEvent(e) {
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const li = chart.timeScale().coordinateToLogical(x);
    return { x, y, t: li == null ? null : timeOfIdx(li), price: candleS.coordinateToPrice(y) };
  }

  /* ---------------- drawings (saved per symbol) ---------------- */
  const key = () => `${S.market}|${S.symbol.toUpperCase()}`;
  S.drawings = store.get('pa_draw', {});
  const list = () => (S.drawings[key()] ||= []);
  const saveDraw = () => store.set('pa_draw', S.drawings);
  let tool = 'cursor', pending = null, preview = null;
  function setTool(t) {
    tool = t; pending = null; preview = null;
    $$('#chartTools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    svg.classList.toggle('active', t !== 'cursor');
    chart.applyOptions({ handleScroll: t === 'cursor', handleScale: t === 'cursor' });
    render();
  }
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const el = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };
  function drawShape(g, d, ghost) {
    const W = width(), cls = ghost ? 'drw ghost' : 'drw';
    const p = d.p.map(q => ({ x: xOf(q.t), y: yOf(q.price) }));
    if (p.some(q => q.x == null || q.y == null)) return;
    const grp = el('g', { class: cls, 'data-id': d.id || '' });
    if (d.type === 'trend') grp.append(el('line', { x1: p[0].x, y1: p[0].y, x2: p[1].x, y2: p[1].y }), el('circle', { cx: p[0].x, cy: p[0].y, r: 3 }), el('circle', { cx: p[1].x, cy: p[1].y, r: 3 }));
    if (d.type === 'hline') grp.append(el('line', { x1: 0, y1: p[0].y, x2: W, y2: p[0].y }), el('text', { x: W - 4, y: p[0].y - 4, 'text-anchor': 'end' }, fmt(d.p[0].price)));
    if (d.type === 'ray') grp.append(el('line', { x1: p[0].x, y1: p[0].y, x2: W, y2: p[0].y }), el('circle', { cx: p[0].x, cy: p[0].y, r: 3 }), el('text', { x: W - 4, y: p[0].y - 4, 'text-anchor': 'end' }, fmt(d.p[0].price)));
    if (d.type === 'rect') grp.append(el('rect', { x: Math.min(p[0].x, p[1].x), y: Math.min(p[0].y, p[1].y), width: Math.abs(p[1].x - p[0].x), height: Math.abs(p[1].y - p[0].y), class: 'fill' }));
    if (d.type === 'fib') {
      const x1 = Math.min(p[0].x, p[1].x), x2 = Math.max(p[0].x, p[1].x, x1 + 40);
      FIB.forEach(f => {
        const price = d.p[1].price + (d.p[0].price - d.p[1].price) * f, y = yOf(price); if (y == null) return;
        grp.append(el('line', { x1, y1: y, x2, y2: y, class: 'fib f' + String(f).replace('.', '') }), el('text', { x: x1 + 3, y: y - 3, class: 'fibt' }, `${f} (${fmt(price)})`));
      });
      grp.append(el('line', { x1: p[0].x, y1: p[0].y, x2: p[1].x, y2: p[1].y, class: 'dash' }));
    }
    if (d.type === 'text') grp.append(el('text', { x: p[0].x, y: p[0].y, class: 'note' }, d.text || ''));
    g.append(grp);
  }

  /* ---------------- indicators ---------------- */
  const IND = [
    ['ema', 'EMA 20 / 50', 'Two moving averages — the trend'],
    ['ema200', 'EMA 200', 'Long-term trend filter'],
    ['msnr', 'MSNR key levels', 'Supply & demand levels D1 · H4 · H1 — ★ = fresh (untested)'],
    ['zones', 'Smart-money zones', 'Order blocks, FVG, OTE, liquidity sweeps — limit entry zones'],
    ['sessions', 'Trading sessions', 'Tokyo · London · New York — each session’s range box'],
    ['pdhl', 'Previous day high / low', 'Yesterday’s range — liquidity targets'],
    ['bb', 'Bollinger Bands', '20, 2 — volatility envelope'],
    ['vwap', 'VWAP', 'Session volume-weighted average price'],
    ['volume', 'Volume', 'Bars at the bottom of the chart'],
    ['rsi', 'RSI (14)', 'Momentum, 70 / 30 levels'],
    ['macd', 'MACD (12, 26, 9)', 'Momentum & trend changes']
  ];
  S.settings.ind = Object.assign({ ema: true, ema200: true, msnr: true, zones: false, sessions: true, pdhl: false, bb: false, vwap: false, volume: true, rsi: false, macd: false }, S.settings.ind || {});
  const on = k => !!S.settings.ind[k];
  const lineS = (color, w = 1, scale = 'right', style = 0) => chart.addLineSeries({ color, lineWidth: w, lineStyle: style, priceScaleId: scale, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ser = {};
  function ensureSeries() {
    if (!ser.bbU) { ser.bbU = lineS('rgba(33,150,243,.7)'); ser.bbM = lineS('rgba(255,109,0,.6)', 1, 'right', 2); ser.bbL = lineS('rgba(33,150,243,.7)'); }
    if (!ser.vwap) ser.vwap = lineS('#e91e63', 2);
    if (!ser.rsi) {
      ser.rsi = lineS('#7e57c2', 1.5, 'rsi');
      ser.rsi.createPriceLine({ price: 70, color: 'rgba(120,123,134,.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      ser.rsi.createPriceLine({ price: 30, color: 'rgba(120,123,134,.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    }
    if (!ser.macdH) { ser.macdH = chart.addHistogramSeries({ priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false }); ser.macdL = lineS('#2962ff', 1.5, 'macd'); ser.macdS = lineS('#ff6d00', 1.5, 'macd'); }
  }
  function layoutPanes() {
    const r = on('rsi'), m = on('macd'), pane = 0.2;
    const bottom = (r ? pane : 0) + (m ? pane : 0);
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: bottom + 0.14 } });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 1 - bottom - 0.14, bottom } });
    if (r) chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 1 - (m ? 2 * pane : pane) + 0.02, bottom: m ? pane : 0.01 }, borderVisible: false });
    if (m) chart.priceScale('macd').applyOptions({ scaleMargins: { top: 1 - pane + 0.02, bottom: 0.01 }, borderVisible: false });
  }
  function updateIndicators() {
    const cs = S.candles; if (!cs.length) return;
    ensureSeries();
    const c = cs.map(x => x.close), pts = arr => cs.map((k, i) => arr[i] == null ? null : { time: k.time, value: arr[i] }).filter(Boolean);
    e20S.applyOptions({ visible: on('ema') }); e50S.applyOptions({ visible: on('ema') }); e200S.applyOptions({ visible: on('ema200') });
    volS.applyOptions({ visible: on('volume') });
    const B = bollinger(c);
    [['bbU', 'up'], ['bbM', 'mid'], ['bbL', 'lo']].forEach(([k, f]) => { ser[k].setData(on('bb') ? cs.map((x, i) => B[i] ? { time: x.time, value: B[i][f] } : null).filter(Boolean) : []); });
    if (on('vwap')) {
      let day = null, pv = 0, v = 0; const vw = cs.map(x => { const d = Math.floor(x.time / 86400); if (d !== day) { day = d; pv = 0; v = 0; } const w = x.volume || 1; pv += (x.high + x.low + x.close) / 3 * w; v += w; return pv / v; });
      ser.vwap.setData(pts(vw));
    } else ser.vwap.setData([]);
    ser.rsi.setData(on('rsi') ? pts(rsi(c)) : []);
    if (on('macd')) { const M = macd(c); ser.macdL.setData(pts(M.line)); ser.macdS.setData(pts(M.sig)); ser.macdH.setData(cs.map((x, i) => M.hist[i] == null ? null : { time: x.time, value: M.hist[i], color: M.hist[i] >= 0 ? 'rgba(8,153,129,.6)' : 'rgba(242,54,69,.6)' }).filter(Boolean)); }
    else { ser.macdL.setData([]); ser.macdS.setData([]); ser.macdH.setData([]); }
    layoutPanes();
    if (on('msnr')) loadMsnr();
    render();
  }

  /* MSNR (Malaysian support & resistance): levels made by candle bodies, not wicks.
     A-level = bullish close followed by a bearish open (peak) · V-level = bearish close followed by a bullish open (valley).
     Fresh (no wick has touched it since) = ★ strong. Taken from D1, H4 and H1. */
  const msnrCache = {};
  function msnrLevels(cs, tag) {
    const out = [];
    for (let i = 1; i < cs.length - 1; i++) {
      const a = cs[i], b = cs[i + 1];
      if (a.close > a.open && b.close < b.open) out.push({ p: Math.max(a.close, b.open), type: 'A', t: a.time, i });
      if (a.close < a.open && b.close > b.open) out.push({ p: Math.min(a.close, b.open), type: 'V', t: a.time, i });
    }
    // keep the strongest swing levels (body peaks/valleys that reversed price) and mark fresh ones
    const last = cs[cs.length - 1].close;
    return out.filter(l => {
      const seg = cs.slice(Math.max(0, l.i - 3), l.i + 5);
      return l.type === 'A' ? seg.every(x => Math.max(x.open, x.close) <= l.p + 1e-9) : seg.every(x => Math.min(x.open, x.close) >= l.p - 1e-9);
    }).map(l => ({ ...l, tag, fresh: !cs.slice(l.i + 2).some(x => x.low <= l.p && x.high >= l.p), dist: Math.abs(l.p - last) }))
      .sort((x, y) => x.dist - y.dist).slice(0, 4);
  }
  async function loadMsnr() {
    const k = key(); if (msnrCache[k] && Date.now() - msnrCache[k].at < 10 * 60e3) return;
    msnrCache[k] = { at: Date.now(), levels: msnrCache[k]?.levels || [] };
    const tfsL = [['1d', 'D1'], ['4h', 'H4'], ['1h', 'H1']];
    const lv = [];
    for (const [tf, tag] of tfsL) {
      try { const d = await fetchCandles(S.market, S.symbol, tf, 300); if (d.candles?.length > 20) lv.push(...msnrLevels(d.candles.slice(-200), tag)); } catch { }
    }
    msnrCache[k] = { at: Date.now(), levels: lv };
    render();
  }

  function renderOverlays(g) {
    const W = width(), cs = S.candles; if (!cs.length) return;
    // sessions (intraday charts only)
    if (on('sessions') && tfs() <= 3600) {
      const SES = [['Tokyo', 0, 9, 'ses-tk'], ['London', 8, 17, 'ses-ld'], ['New York', 13, 22, 'ses-ny']];
      const lastDay = Math.floor(cs[cs.length - 1].time / 86400);
      for (let d = lastDay - 4; d <= lastDay; d++) SES.forEach(([name, h0, h1, cls]) => {
        const t0 = d * 86400 + h0 * 3600, t1 = d * 86400 + h1 * 3600;
        const bars = cs.filter(x => x.time >= t0 && x.time < t1); if (!bars.length) return;
        const hi = Math.max(...bars.map(x => x.high)), lo = Math.min(...bars.map(x => x.low));
        const x0 = xOf(t0), x1 = xOf(Math.min(t1, cs[cs.length - 1].time + tfs())), y0 = yOf(hi), y1 = yOf(lo);
        if ([x0, x1, y0, y1].some(v => v == null) || x1 < 0 || x0 > W) return;
        g.append(el('rect', { x: Math.max(0, x0), y: y0, width: Math.max(0, Math.min(W, x1) - Math.max(0, x0)), height: Math.max(1, y1 - y0), class: 'ses ' + cls }));
        if (x0 >= 0) g.append(el('text', { x: x0 + 3, y: y0 - 3, class: 'ses-t ' + cls }, name));
      });
    }
    // previous day high / low
    if (on('pdhl') && S.ind?.keys) [['PDH', S.ind.keys.pdh], ['PDL', S.ind.keys.pdl]].forEach(([n, v]) => {
      const y = v && yOf(v); if (y == null) return;
      g.append(el('line', { x1: 0, y1: y, x2: W, y2: y, class: 'pdl' }), el('text', { x: 4, y: y - 3, class: 'pdl-t' }, `${n} ${fmt(v)}`));
    });
    // MSNR
    if (on('msnr')) (msnrCache[key()]?.levels || []).forEach(l => {
      const y = yOf(l.p); if (y == null) return;
      const x0 = Math.max(0, xOf(l.t) ?? 0);
      g.append(el('line', { x1: x0, y1: y, x2: W, y2: y, class: 'snr ' + (l.type === 'A' ? 'res' : 'sup') + (l.fresh ? ' fresh' : '') }),
        el('text', { x: W - 4, y: y - 3, 'text-anchor': 'end', class: 'snr-t ' + (l.type === 'A' ? 'res' : 'sup') }, `${l.tag} ${l.type === 'A' ? 'A' : 'V'}${l.fresh ? ' ★' : ''} ${fmt(l.p)}`));
    });
    // smart-money confluence zones
    if (on('zones')) (S.ind?.zones || []).slice(0, 4).forEach(z => {
      const y0 = yOf(z.hi), y1 = yOf(z.lo); if (y0 == null || y1 == null) return;
      const x0 = Math.max(0, W * 0.55);
      g.append(el('rect', { x: x0, y: y0, width: W - x0, height: Math.max(2, y1 - y0), class: 'smz ' + z.side }), el('text', { x: x0 + 4, y: y0 + 11, class: 'smz-t' }, z.tags.slice(0, 3).join(' + ')));
    });
  }

  /* ---------------- render ---------------- */
  let raf = 0;
  function render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; try { renderNow(); } catch (e) { } }); }
  function renderNow() {
    if (!svg || $('#chart').classList.contains('hidden')) { if (svg) svg.innerHTML = ''; return; }
    svg.innerHTML = '';
    const go = el('g', { class: 'ovl' }), gd = el('g', {});
    renderOverlays(go);
    list().forEach(d => drawShape(gd, d));
    if (preview) drawShape(gd, preview, true);
    svg.append(go, gd);
  }

  /* ---------------- pointer handling ---------------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const TWO = ['trend', 'rect', 'fib'];
  svg.addEventListener('pointerdown', e => {
    if (tool === 'cursor') return;
    e.preventDefault();
    const p = ptFromEvent(e); if (p.t == null || p.price == null) return;
    if (tool === 'erase') {
      const hit = e.target.closest('g.drw');
      if (hit && hit.dataset.id) { S.drawings[key()] = list().filter(d => d.id !== hit.dataset.id); saveDraw(); render(); }
      return;
    }
    if (tool === 'hline' || tool === 'ray') { list().push({ id: uid(), type: tool, p: [{ t: p.t, price: p.price }] }); saveDraw(); setTool('cursor'); return; }
    if (tool === 'text') { const txt = prompt('Note text:'); if (txt) { list().push({ id: uid(), type: 'text', text: txt.slice(0, 60), p: [{ t: p.t, price: p.price }] }); saveDraw(); } setTool('cursor'); return; }
    if (TWO.includes(tool)) {
      if (!pending) { pending = { t: p.t, price: p.price, x: p.x, y: p.y }; svg.setPointerCapture?.(e.pointerId); }
      else finish(p);
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!pending) return;
    const p = ptFromEvent(e); if (p.t == null) return;
    preview = { type: tool, p: [{ t: pending.t, price: pending.price }, { t: p.t, price: p.price }] }; render();
  });
  svg.addEventListener('pointerup', e => {
    if (!pending) return;
    const p = ptFromEvent(e);
    if (Math.hypot(p.x - pending.x, p.y - pending.y) > 8) finish(p); // dragged → done; tap → wait for 2nd tap
  });
  function finish(p) {
    if (p.t == null || p.price == null) return;
    list().push({ id: uid(), type: tool, p: [{ t: pending.t, price: pending.price }, { t: p.t, price: p.price }] });
    saveDraw(); pending = null; preview = null; setTool('cursor');
  }

  /* ---------------- toolbar + indicators panel ---------------- */
  $('#chartTools').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool === tool ? 'cursor' : b.dataset.tool);
    if (b.dataset.act === 'clear') { if (list().length && confirm('Delete all drawings on ' + S.symbol.toUpperCase() + '?')) { S.drawings[key()] = []; saveDraw(); render(); } }
    if (b.dataset.act === 'theme') applyTheme(document.body.dataset.chart === 'light' ? 'dark' : 'light');
    if (b.dataset.act === 'ind') openInd();
  });
  function openInd() {
    $('#indList').innerHTML = IND.map(([k, n, d]) => `<label class="ind-row2"><span><b>${n}</b><small>${d}</small></span><input type="checkbox" class="sw" data-ind="${k}" ${on(k) ? 'checked' : ''}></label>`).join('');
    $('#indModal').classList.remove('hidden');
  }
  $('#indList').addEventListener('change', e => {
    const k = e.target.dataset.ind; if (!k) return;
    S.settings.ind[k] = e.target.checked; saveSettings(); updateIndicators();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && tool !== 'cursor') setTool('cursor'); });

  /* ---------------- hooks into the app ---------------- */
  const origDraw = window.drawSeries || drawSeries;
  drawSeries = function () { origDraw.apply(this, arguments); updateIndicators(); };
  let lastInd = 0;
  const origTick = onTick;
  onTick = function (c) { origTick(c); try { if (Date.now() - lastInd > 3000) { lastInd = Date.now(); updateIndicators(); } else render(); } catch (e) { console.warn('indicators', e); } };
  chart.timeScale().subscribeVisibleLogicalRangeChange(render);
  chart.subscribeCrosshairMove(() => { if (pending) return; });
  setInterval(render, 500); // keep overlays aligned when the price scale auto-moves
  new ResizeObserver(render).observe($('#chart'));
  window.PrymeChart = { applyTheme, updateIndicators, render, setTool };
  applyTheme(S.settings.chartTheme || 'light', false);
  if (S.candles.length) updateIndicators();
})();

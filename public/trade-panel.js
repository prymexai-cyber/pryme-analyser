/* ============================================================
   PRYME QUANT — manual trade panel
   SELL (bid) · lot − / + · BUY (ask) · optional SL / TP in pips
   Open P/L · equity · margin · Positions / Orders
   ============================================================ */
'use strict';
(() => {
  const LEV = { forex: 100, crypto: 10, stock: 1, cse: 1 };
  S.settings.lots = S.settings.lots || {};
  let tpTab = 'pos';

  const mid = () => S.candles.length ? S.candles[S.candles.length - 1].close : null;
  // typical broker spread so BUY uses the ask and SELL uses the bid
  function spreadFor(market, symbol, price) {
    const s = String(symbol).toUpperCase(), pip = pipSizeFor(market, symbol, price);
    if (market === 'forex') {
      if (/^XAU|^GOLD/.test(s)) return pip; // $0.10 on gold, like most brokers
      if (/^XAG/.test(s)) return 2 * pip;
      if (/NAS100|US30|SPX500|GER40|UK100|JP225/.test(s)) return 1 * pip;
      return (/^(EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF|NZDUSD)$/.test(s) ? 1.2 : 2.5) * pip;
    }
    if (market === 'crypto') return price * 0.0002;
    return pip; // stocks / CSE: one tick
  }
  const lotStep = (market, symbol, price) => {
    if (market === 'forex') return 0.01;
    if (market === 'crypto') return Math.pow(10, Math.floor(Math.log10(100 / (price || 1))));
    return 1;
  };
  const unitName = market => market === 'forex' ? 'lot' : market === 'crypto' ? S.symbol.toUpperCase().replace(/USDT|USDC|BUSD|FDUSD$/, '') : 'shares';
  const unitsFromLot = (market, symbol, lot) => lot * contractSize(market, symbol);
  const lotKey = () => `${S.market}|${S.symbol.toUpperCase()}`;
  function getLot() {
    const px = mid(), st = lotStep(S.market, S.symbol, px);
    let v = +$('#tpLot').value;
    if (!(v > 0)) v = S.settings.lots[lotKey()] || st;
    return +(Math.round(v / st) * st).toFixed(8);
  }
  function setLot(v) {
    const st = lotStep(S.market, S.symbol, mid());
    v = Math.max(st, +(Math.round(v / st) * st).toFixed(8));
    $('#tpLot').value = v; S.settings.lots[lotKey()] = v; saveSettings(); renderTradePanel();
  }

  function stats() {
    const acc = ACC(), out = { pl: { USD: 0, LKR: 0 }, margin: { USD: 0, LKR: 0 } };
    acc.positions.forEach(p => {
      const px = S.livePrices[p.market + '|' + p.symbol];
      if (p.status === 'open' && px != null) out.pl[p.cur] += (px - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor;
      if (p.status === 'open') out.margin[p.cur] += p.entry * p.remaining * p.factor / (LEV[p.market] || 1);
    });
    return out;
  }

  window.renderTradePanel = function renderTradePanel() {
    if (!$('#tradePanel')) return;
    const acc = ACC(), cur = curOf(S.market), real = S.settings.active === 'real';
    $('#tpAccLabel').textContent = real ? 'REAL ACCOUNT · tracking' : 'PRACTICE ACCOUNT';
    $('#tpAccLabel').className = 'tp-badge ' + (real ? 'real' : '');
    $('#tpBal').textContent = money(acc[cur], cur);
    $('#tpAccSwitch').textContent = real ? 'Switch to Demo' : 'Switch to Real';
    const px = mid();
    $('#tpSym').textContent = `${S.symbol.toUpperCase()} · ${S.market.toUpperCase()}`;
    if (px == null) { $('#tpBid').textContent = '—'; $('#tpAsk').textContent = '—'; }
    else {
      const sp = spreadFor(S.market, S.symbol, px);
      $('#tpBid').textContent = fmt(px - sp / 2); $('#tpAsk').textContent = fmt(px + sp / 2);
    }
    // lot box follows the symbol: reset when the symbol changes, only once a price is known
    if (px != null && (S._lotKey !== lotKey() || !$('#tpLot').value)) { S._lotKey = lotKey(); $('#tpLot').value = S.settings.lots[lotKey()] || lotStep(S.market, S.symbol, px); }
    $('#tpLotUnit').textContent = unitName(S.market);
    if (px != null) {
      const lot = getLot(), units = unitsFromLot(S.market, S.symbol, lot), f = quoteFactor(S.market, S.symbol, px);
      const pip = pipSizeFor(S.market, S.symbol, px), pipVal = pip * units * f, margin = px * units * f / (LEV[S.market] || 1);
      const pv = pipVal < 0.995 ? (cur === 'LKR' ? 'Rs ' : '$') + pipVal.toFixed(pipVal < 0.01 ? 4 : 3) : money(pipVal, cur);
      $('#tpInfo').innerHTML = `Spread ${fmt(spreadFor(S.market, S.symbol, px))} · 1 pip = <b>${pv}</b> · margin ${money(margin, cur)} · 1:${LEV[S.market] || 1}`;
    }
    const st = stats(), pl = st.pl[cur];
    const el = $('#tpOpenPL'); el.textContent = `${pl >= 0 ? '+' : ''}${money(pl, cur)}`; el.className = pl >= 0 ? 'up' : 'down';
    $('#tpEquity').textContent = money(acc[cur] + pl, cur);
    $('#tpMargin').textContent = money(st.margin[cur], cur);
    const open = acc.positions.filter(p => p.status === 'open'), pend = acc.positions.filter(p => p.status === 'pending');
    $('#tpPosN').textContent = open.length; $('#tpOrdN').textContent = pend.length;
    $$('#tpTabs [data-tpt]').forEach(b => b.classList.toggle('on', b.dataset.tpt === tpTab));
    const items = tpTab === 'pos' ? open : pend;
    $('#tpList').innerHTML = items.length ? items.map(p => {
      const q = S.livePrices[p.market + '|' + p.symbol];
      const v = p.status === 'open' && q != null ? (q - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor : null;
      const pp = p.status === 'open' && q != null ? pipsOpen(p, q) : null;
      return `<div class="tp-item">
        <div class="tpi-l"><span class="tag ${p.dir}">${p.dir === 'long' ? 'BUY' : 'SELL'}</span> <b>${fmtSize(p, p.remaining)}</b> ${esc(p.symbol)} ${p.code ? `<small class="tcode">${esc(p.code)}</small>` : ''}
          <small>${p.status === 'pending' ? esc(p.type) + ' @ ' : ''}${fmt(p.entry, p.prec)}${q != null && p.status === 'open' ? ' → ' + fmt(q, p.prec) : ''}${p.sl != null ? ' · SL ' + fmt(p.sl, p.prec) : ''}${p.tp2 != null ? ' · TP ' + fmt(p.tp2, p.prec) : ''}</small></div>
        <div class="tpi-r">${v != null ? `<b class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${money(v, p.cur)}</b><small class="${pp >= 0 ? 'up' : 'down'}">${fmtPips(pp)} pips</small>` : ''}
          <button class="x" data-tpclose="${p.id}">${p.status === 'pending' ? 'Cancel' : 'Close'}</button></div>
      </div>`;
    }).join('') : `<p class="tp-empty">${tpTab === 'pos' ? 'No open positions' : 'No pending orders'}</p>`;
    $('#tpNote').textContent = real
      ? 'Real account: Pryme does not send orders to your broker. Place the same trade at your broker — Pryme tracks it here on the live price.'
      : 'Demo money on live prices. Spread and margin are simulated like a typical broker.';
  };

  function levelsFromPips(dir, entry) {
    const pip = pipSizeFor(S.market, S.symbol, entry), sg = dir === 'long' ? 1 : -1;
    const slP = +$('#tpSL').value, tpP = +$('#tpTP').value;
    return { sl: slP > 0 ? entry - sg * slP * pip : null, tp: tpP > 0 ? entry + sg * tpP * pip : null };
  }
  function place(dir) {
    const px = mid();
    if (px == null || !S.ind) return toast('Wait for the chart to load');
    const real = S.settings.active === 'real';
    const sp = spreadFor(S.market, S.symbol, px), entry = dir === 'long' ? px + sp / 2 : px - sp / 2;
    const lot = getLot(), units = unitsFromLot(S.market, S.symbol, lot);
    const { sl, tp } = levelsFromPips(dir, entry);
    const acc = ACC(), cur = curOf(S.market), f = quoteFactor(S.market, S.symbol, px);
    const margin = entry * units * f / (LEV[S.market] || 1);
    const st = stats();
    if (!real && margin > acc[cur] + st.pl[cur] - st.margin[cur]) return toast('Not enough free margin for this size');
    if (real && !confirm(`Track a REAL ${dir === 'long' ? 'BUY' : 'SELL'} ${lot} ${unitName(S.market)} ${S.symbol.toUpperCase()} at ${fmt(entry)}?\n\nPlace the same order at your broker — Pryme only tracks it.`)) return;
    const s = { direction: dir, name: 'Manual', tp3: null };
    const pos = createPosition(S.settings.active, s, { entry, sl, tp1: null, tp2: tp, units, market: true });
    pos.entry = entry; pos.manual = true; pos.lot = lot; pos.sl0 = sl;
    saveAccounts();
    addLog(`${real ? 'Real' : 'Demo'} manual ${dir === 'long' ? 'BUY' : 'SELL'} ${lot} ${unitName(S.market)} ${pos.symbol} @ ${fmt(entry)}${sl != null ? ' · SL ' + fmt(sl) : ''}${tp != null ? ' · TP ' + fmt(tp) : ''}`);
    toast(`${dir === 'long' ? 'BUY' : 'SELL'} ${lot} ${unitName(S.market)} @ ${fmt(entry)}`);
    try { drawPositions(); renderLvlBox(); renderAccounts(); renderAcctCard(); } catch { }
    tpTab = 'pos'; renderTradePanel();
  }
  function closeOne(id) {
    const acc = ACC(), p = acc.positions.find(x => x.id === id); if (!p) return;
    if (p.status === 'pending') { acc.positions = acc.positions.filter(x => x.id !== id); toast('Order cancelled'); }
    else {
      const q = S.livePrices[p.market + '|' + p.symbol]; if (q == null) return toast('Waiting for live price…');
      const sp = p.market === S.market && p.symbol === S.symbol.toUpperCase() ? spreadFor(p.market, p.symbol, q) : 0;
      closePart(p, p.dir === 'long' ? q - sp / 2 : q + sp / 2, p.remaining, 'Closed manually');
    }
    saveAccounts(); try { drawPositions(); renderLvlBox(); renderAccounts(); renderAcctCard(); } catch { }
    renderTradePanel();
  }

  /* wiring */
  $('#tpSell').onclick = () => place('short');
  $('#tpBuy').onclick = () => place('long');
  $('#tpMinus').onclick = () => { const st = lotStep(S.market, S.symbol, mid()); setLot(getLot() - st); };
  $('#tpPlus').onclick = () => { const st = lotStep(S.market, S.symbol, mid()); setLot(getLot() + st); };
  $('#tpLot').onchange = e => setLot(+e.target.value || 0);
  $('#tpAccSwitch').onclick = () => { setActive(S.settings.active === 'real' ? 'demo' : 'real'); renderTradePanel(); };
  $('#tpTabs').onclick = e => { const b = e.target.closest('[data-tpt]'); if (b) { tpTab = b.dataset.tpt; renderTradePanel(); } };
  $('#tpList').onclick = e => { const b = e.target.closest('[data-tpclose]'); if (b) closeOne(b.dataset.tpclose); };
  $('#tpUseAi').onclick = () => {
    const s = S.setups[S.selected ?? 0]; if (!s) return toast('Run "Analyse with AI" first');
    const pip = pipSizeFor(S.market, S.symbol, s.entry);
    $('#tpSL').value = +(Math.abs(s.entry - s.stopLoss) / pip).toFixed(1);
    $('#tpTP').value = +(Math.abs(s.tp2 - s.entry) / pip).toFixed(1);
    toast(`AI setup #${(S.selected ?? 0) + 1}: ${s.direction === 'long' ? 'BUY' : 'SELL'} — SL ${$('#tpSL').value} / TP ${$('#tpTP').value} pips`);
  };

  /* keep it live */
  let last = 0;
  const prevTick = onTick;
  onTick = function (c) { prevTick(c); if (Date.now() - last > 400) { last = Date.now(); renderTradePanel(); } };
  const prevAcc = renderAccounts;
  renderAccounts = function () { prevAcc.apply(this, arguments); renderTradePanel(); };
  const prevLoad = loadMarket;
  loadMarket = async function () { $('#tpLot').value = ''; S._lotKey = null; const r = await prevLoad.apply(this, arguments); renderTradePanel(); return r; };
  renderTradePanel();
})();

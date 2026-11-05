/* ============================================================
   PRYME AGENT — AI assistant inside Pryme Quant
   - chat in Sinhala, Singlish or English using your AI keys (auto failover)
   - reads the live chart, the last analysis, your trades and balances
   - can act: load a symbol, give a signal, take limit/market entries, set price alerts,
     add symbols to its watch list, change theme / indicators, run a backtest
   - background watch: the server scans your watch list and pushes a notification
     to this phone / PC when it finds a clean setup (even when the app is closed)
   ============================================================ */
'use strict';
(() => {
  const MAXMSG = 60;
  let chat = store.get('pa_chat', []);
  let alerts = store.get('pa_alerts', []); // price alerts
  S.settings.agentWatch = Array.isArray(S.settings.agentWatch) ? S.settings.agentWatch : [];
  S.settings.agentMin = S.settings.agentMin || 70;
  const AG_ID = (() => { let id = store.get('pa_agent_id', null); if (!id) { id = 'pq' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('pa_agent_id', id); } return id; })();
  const save = () => { chat = chat.slice(-MAXMSG); store.set('pa_chat', chat); };
  const saveAlerts = () => store.set('pa_alerts', alerts.slice(-30));
  const keys = () => (S.settings.keys || []).filter(k => k.enabled !== false && k.key);
  const symName = { XAUUSD: 'Gold', XAGUSD: 'Silver', BTCUSDT: 'Bitcoin', ETHUSDT: 'Ethereum', NAS100: 'Nasdaq 100', US30: 'Dow Jones' };

  /* ---------- rendering ---------- */
  const box = $('#agMsgs');
  const md = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  function msgHTML(m, i) {
    if (m.r === 'sys') return `<div class="msg sys">${md(m.t)}</div>`;
    let x = `<div class="msg ${m.r}" data-i="${i}">${md(m.t)}`;
    if (m.setups) x += m.setups.map((s, k) => `<div class="m-setup"><b class="${s.dir}">#${k + 1} ${s.dir === 'long' ? 'BUY' : 'SELL'}</b> ${esc(s.grade || '')} · entry ${esc(s.entry)} · SL ${esc(s.sl)} · TP ${esc(s.tp1)} / ${esc(s.tp2)}</div>`).join('');
    if (m.acts && !m.done) x += `<div class="m-acts">${m.acts.map((a, k) => `<button class="${a.primary ? 'go' : ''}" data-act="${k}">${esc(a.label)}</button>`).join('')}</div>`;
    if (m.done) x += `<span class="m-done">${esc(m.done)}</span>`;
    return x + '</div>';
  }
  function render(scroll = true) {
    if (!chat.length) chat.push({ r: 'ai', t: hello(), ts: Date.now() });
    box.innerHTML = chat.map(msgHTML).join('');
    if (scroll) box.scrollTop = box.scrollHeight;
  }
  function hello() {
    const n = (window.PrymeCloud?.getProfile?.().name || '').split(' ')[0];
    return `Ayubowan${n ? ' ' + n : ''}! 👋 Mama Pryme Agent.\nChart eka gana ahanna, signal ekak ganna, limit / market entry ganna, price alert danna — Sinhala, Singlish, English okkoma puluwan.\n\nE.g. "gold 1h signal ekak denna", "explain this chart", "BTC 40000 ta awoth kiyanna".`;
  }
  function add(r, t, extra = {}) { const m = { r, t: String(t || '').slice(0, 3000), ts: Date.now(), ...extra }; chat.push(m); save(); render(); return m; }
  function typing(on) {
    $('#agSend').disabled = on;
    const t = box.querySelector('.typing'); if (t) t.remove();
    if (on) { box.insertAdjacentHTML('beforeend', '<div class="msg ai typing"><i></i><i></i><i></i></div>'); box.scrollTop = box.scrollHeight; }
  }
  const CHIPS = [
    ['📈 Signal for this chart', 'Give me the best entry for this chart now'],
    ['🔍 Explain this chart', 'Explain this chart simply — trend, key levels, what to watch'],
    ['🥇 Gold 1H', 'XAUUSD 1h signal ekak denna'],
    ['₿ BTC 15m', 'BTCUSDT 15m signal'],
    ['💼 My trades', 'How are my open trades doing?'],
    ['👁 Watch this', 'Add this chart to your watch list and alert me'],
    ['🇱🇰 සිංහලෙන්', 'මේ chart එක සිංහලෙන් පැහැදිලි කරන්න']
  ];
  $('#agChips').innerHTML = CHIPS.map(([l, q]) => `<button data-q="${esc(q)}">${esc(l)}</button>`).join('');
  $('#agChips').onclick = e => { const b = e.target.closest('[data-q]'); if (b) send(b.dataset.q); };

  /* ---------- context for the AI ---------- */
  const f = v => (v == null || !isFinite(v)) ? '—' : fmt(v);
  function context() {
    const I = S.ind || {}, A = S.analysis, px = S.candles.length ? S.candles[S.candles.length - 1].close : null;
    const pos = [...S.accounts.demo.positions, ...S.accounts.real.positions].map(p => {
      const q = S.livePrices[p.market + '|' + p.symbol];
      const pl = q != null && p.status === 'open' ? (q - p.entry) * (p.dir === 'long' ? 1 : -1) * p.remaining * p.factor : null;
      return `${p.code || ''} ${p.acc.toUpperCase()} ${p.symbol} ${p.dir === 'long' ? 'BUY' : 'SELL'} ${p.status} entry ${f(p.entry)} SL ${f(p.sl)} TP ${f(p.tp1 ?? p.tp2)}${pl != null ? ` P/L ${money(pl, p.cur)}` : ''}`;
    });
    const sets = (S.setups || []).map((s, i) => `#${i + 1} ${s.direction === 'long' ? 'BUY' : 'SELL'} ${orderTypeOf(s, px, I.atr || 0)} entry ${f(s.entry)} SL ${f(s.stopLoss)} TP1 ${f(s.tp1)} TP2 ${f(s.tp2)} grade ${s.grade || '-'} ${s.ok === false ? '(watch-only)' : '(tradeable)'}`);
    const now = new Date().toLocaleString('en-GB', { timeZone: S.settings.tz || 'Asia/Colombo', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return [
      `Time: ${now} (${S.settings.tz})`,
      `Chart: market=${S.market} symbol=${S.symbol.toUpperCase()} tf=${S.tf} price=${f(px)} feed=${S.meta?.feed || ''}`,
      S.ind ? `Indicators: EMA50 ${f(I.ema50)} EMA200 ${f(I.ema200)} trend ${I.ema50 > I.ema200 ? 'up' : 'down'}, RSI ${I.rsi?.toFixed?.(1)}, ATR ${f(I.atr)}, ADX ${I.adx?.adx?.toFixed?.(0) ?? '—'}, structure: ${I.structure || '—'}${I.keys ? `, PDH ${f(I.keys.pdh)} PDL ${f(I.keys.pdl)}` : ''}` : 'Indicators: not loaded',
      A ? `Last analysis (${S.analysis.tf || S.tf}): bias ${A.bias}, score ${A.score}. ${String(A.summary || '').slice(0, 400)}` : 'Last analysis: none yet',
      sets.length ? 'Setups:\n' + sets.join('\n') : 'Setups: none',
      S.deep ? `29-method check: ${S.deep.side} side, ${Math.round((S.deep.agree || 0) * 100)}% agree` : '',
      `Accounts: Demo ${money(S.accounts.demo.USD)} / ${money(S.accounts.demo.LKR, 'LKR')}, Real ${money(S.accounts.real.USD)} / ${money(S.accounts.real.LKR, 'LKR')}, active=${S.settings.active}, risk ${S.settings.riskPct}%`,
      pos.length ? 'Open trades:\n' + pos.join('\n') : 'Open trades: none',
      `Watch list: ${S.settings.agentWatch.map(w => `${w.symbol} ${w.tf}`).join(', ') || 'empty'} · background alerts ${S.settings.notif?.agent ? 'ON' : 'OFF'}`,
      alerts.length ? `Price alerts: ${alerts.map(a => `${a.symbol} ${a.dir} ${f(a.price)}`).join(', ')}` : '',
      (S.news || []).length ? 'News: ' + S.news.slice(0, 5).map(n => n.title).join(' | ') : ''
    ].filter(Boolean).join('\n');
  }
  const SYSTEM = `You are "Pryme Agent", the AI trading assistant inside the Pryme Quant app (made by Pryme X). You help the user read charts, find entries and manage trades.
LANGUAGE: reply in the SAME language and script the user writes in. Sinhala script → Sinhala script. Sinhala written in English letters (Singlish) → Singlish. English → English. Keep replies short, friendly and clear (2–6 short lines, use **bold** for prices). No long essays.
HONESTY: never promise profit or a win rate. Mention risk briefly when giving entries. Use only prices from the CONTEXT; never invent prices far from the current price.
You can control the app by adding actions. Available actions:
{"type":"load","market":"forex|crypto|stock|cse","symbol":"XAUUSD","tf":"1m|5m|15m|30m|1h|4h|1d"}  — open a chart (forex also covers gold XAUUSD, silver, oil, NAS100, US30; crypto symbols end in USDT; CSE like JKH.N0000)
{"type":"analyse","tf":"1h"}  — run the full AI analysis (29 methods) on the open chart and show 3–4 setups. Use this whenever the user asks for a signal/entry/setup.
{"type":"take","setup":1,"order":"limit|market","account":"demo|real"}  — take a setup from the last analysis. If the user did not say limit or market, DO NOT take; ask them.
{"type":"trade","dir":"buy|sell","order":"market|limit","entry":0,"sl":0,"tp":0,"lot":0.01,"account":"demo|real"}  — a manual trade on the open chart (entry only for limit; sl/tp optional)
{"type":"close","target":"all|symbol|#PQ001"}  — close open trades
{"type":"alert","price":0,"note":"text"}  — price alert on the open chart
{"type":"watch","market":"forex","symbol":"XAUUSD","tf":"1h"} / {"type":"unwatch","symbol":"XAUUSD"}  — background watch list (the agent scans it and notifies the phone)
{"type":"tab","tab":"home|signals|agent|account"}, {"type":"theme","value":"light|dark"}, {"type":"indicator","name":"ema|ema200|msnr|zones|sessions|pdhl|bb|vwap|volume|rsi|macd","on":true}, {"type":"risk","value":1}, {"type":"backtest"}
Return ONLY JSON: {"reply":"text for the user","actions":[ ... ]}. Use "actions":[] when nothing needs doing. When the user asks for a signal on another symbol, use load then analyse. Explaining a chart needs no action.`;

  /* ---------- talk ---------- */
  let busy = false;
  async function send(text) {
    text = String(text || '').trim(); if (!text || busy) return;
    $('#agText').value = ''; autosize();
    add('me', text);
    busy = true; typing(true);
    try {
      let out;
      if (keys().length) {
        const hist = chat.slice(-12, -1).filter(m => m.r !== 'sys').map(m => `${m.r === 'me' ? 'User' : 'Agent'}: ${m.t}`).join('\n');
        const prompt = `CONTEXT (live app data):\n${context()}\n\nCONVERSATION SO FAR:\n${hist}\n\nUser: ${text}\n\nReturn JSON {"reply":"...","actions":[...]}`;
        try {
          const res = await getJSON('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: keys(), system: SYSTEM, prompt }) });
          out = parse(res.text);
          $('#agStatus').textContent = `Online · ${PROVIDERS[res.provider]?.label || res.provider}`;
        } catch (e) { out = offline(text, true); $('#agStatus').textContent = 'AI keys busy — simple mode'; }
      } else out = offline(text, false);
      typing(false);
      const m = add('ai', out.reply || '👍');
      await runActions(out.actions || [], m);
    } catch (e) { typing(false); add('ai', 'Sorry, something went wrong: ' + e.message); }
    finally { busy = false; typing(false); }
  }
  function parse(t) {
    try { const j = JSON.parse(t); return j; } catch { }
    const m = /\{[\s\S]*\}/.exec(t || ''); if (m) { try { return JSON.parse(m[0]); } catch { } }
    return { reply: String(t || '').slice(0, 1500), actions: [] };
  }
  // no AI key: understand the common requests with simple rules
  const ALIAS = { GOLD: ['forex', 'XAUUSD'], XAU: ['forex', 'XAUUSD'], SILVER: ['forex', 'XAGUSD'], BTC: ['crypto', 'BTCUSDT'], BITCOIN: ['crypto', 'BTCUSDT'], ETH: ['crypto', 'ETHUSDT'], SOL: ['crypto', 'SOLUSDT'], NAS: ['forex', 'NAS100'], NASDAQ: ['forex', 'NAS100'], US30: ['forex', 'US30'], DOW: ['forex', 'US30'] };
  function offline(text, keysFailed) {
    const T = text.toUpperCase(), acts = [];
    const tfm = /\b(1M|5M|15M|30M|1H|4H|1D|H1|H4|D1|M15|M5|M30)\b/.exec(T);
    const tf = tfm ? ({ H1: '1h', H4: '4h', D1: '1d', M15: '15m', M5: '5m', M30: '30m' }[tfm[1]] || tfm[1].toLowerCase()) : null;
    let sym = null;
    for (const w of T.split(/[^A-Z0-9.]+/)) {
      if (ALIAS[w]) { sym = ALIAS[w]; break; }
      if (/^[A-Z]{6}$/.test(w) && /USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD/.test(w)) { sym = ['forex', w]; break; }
      if (/^[A-Z0-9]{2,10}USDT$/.test(w)) { sym = ['crypto', w]; break; }
      if (/^[A-Z]{2,6}\.N0000$/.test(w)) { sym = ['cse', w]; break; }
    }
    if (sym) acts.push({ type: 'load', market: sym[0], symbol: sym[1], tf: tf || S.tf });
    if (/SIGNAL|ENTRY|SETUP|ANALY|TRADE|BUY|SELL/.test(T)) acts.push({ type: 'analyse', tf: sym ? null : tf });
    else if (tf && !sym) acts.push({ type: 'load', market: S.market, symbol: S.symbol, tf });
    const note = keysFailed ? 'AI keys are busy right now, so I used simple mode.' : 'Add a free AI key (Account → AI keys) and I can chat fully in Sinhala / English.';
    if (acts.length) return { reply: `OK 👍 ${acts.map(a => a.type === 'load' ? `${a.symbol} ${a.tf}` : 'getting the signal').join(' → ')}…\n(${note})`, actions: acts };
    return { reply: `${note}\nRight now I can: open a chart and give a signal — try "gold 1h signal" or "BTCUSDT 15m entry".`, actions: [] };
  }

  /* ---------- actions ---------- */
  const okTf = tf => ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].includes(tf);
  const waitFor = (fn, ms = 25000) => new Promise(res => { const t0 = Date.now(); const k = setInterval(() => { if (fn() || Date.now() - t0 > ms) { clearInterval(k); res(fn()); } }, 150); });
  const loadedNow = () => S.candles.length && S.loadedKey === `${S.market}|${S.symbol.toUpperCase()}`;
  async function runActions(list, m) {
    const done = [];
    for (const a of list.slice(0, 6)) {
      try {
        const r = await act(a, m); if (r) done.push(r);
      } catch (e) { done.push('⚠ ' + e.message); }
    }
    if (done.length) { m.done = done.join(' · '); save(); render(); }
  }
  async function act(a, m) {
    const t = String(a.type || '').toLowerCase();
    if (t === 'load') {
      const market = ['forex', 'crypto', 'stock', 'cse'].includes(a.market) ? a.market : S.market;
      const sym = String(a.symbol || S.symbol).toUpperCase().replace(/[^A-Z0-9.]/g, '');
      const tf = okTf(a.tf) ? a.tf : S.tf;
      await switchTo(market, sym, tf); await waitFor(loadedNow);
      if (!loadedNow()) throw new Error(`could not load ${sym}`);
      return `opened ${sym} ${tf.toUpperCase()}`;
    }
    if (t === 'analyse') {
      if (a.tf && okTf(a.tf) && a.tf !== S.tf) { setTF(a.tf); await waitFor(() => S.tf === a.tf && loadedNow()); }
      await waitFor(loadedNow);
      await runAnalysis();
      if (!S.setups.length) return 'no clean setup right now';
      const A = S.analysis, setups = S.setups.map(s => ({ dir: s.direction, grade: s.grade, entry: fmt(s.entry), sl: fmt(s.stopLoss), tp1: fmt(s.tp1), tp2: fmt(s.tp2) }));
      const best = S.setups.findIndex(s => s.ok !== false);
      const acts = [];
      S.setups.slice(0, 2).forEach((s, i) => { acts.push({ label: `#${i + 1} Limit`, act: { type: 'take', setup: i + 1, order: 'limit' }, primary: i === Math.max(0, best) }); acts.push({ label: `#${i + 1} Market`, act: { type: 'take', setup: i + 1, order: 'market' } }); });
      acts.push({ label: 'Show on chart', act: { type: 'tab', tab: 'signals' } });
      add('ai', `**${S.symbol.toUpperCase()} ${S.tf.toUpperCase()} — ${A.bias}** (score ${Math.round(A.score)})\n${String(A.summary || '').slice(0, 320)}\n\nLimit da Market da? Tap karanna 👇`, { setups, acts });
      return null;
    }
    if (t === 'take') {
      const i = (+a.setup || 1) - 1, acc = a.account === 'real' ? 'real' : a.account === 'demo' ? 'demo' : S.settings.active;
      if (!S.setups[i]) throw new Error('no setup #' + (i + 1));
      if (!['limit', 'market'].includes(a.order)) {
        add('ai', `Setup #${i + 1}: limit entry da market (now) da?`, { acts: [{ label: 'Limit', act: { type: 'take', setup: i + 1, order: 'limit', account: acc }, primary: true }, { label: 'Market', act: { type: 'take', setup: i + 1, order: 'market', account: acc } }] });
        return null;
      }
      if (acc === 'real' && !a.confirmed) {
        add('ai', `REAL account: setup #${i + 1} ${a.order} entry. Broker eketh same order eka danna one. Confirm?`, { acts: [{ label: 'Confirm', act: { ...a, account: 'real', confirmed: true }, primary: true }, { label: 'Use Demo', act: { ...a, account: 'demo' } }] });
        return null;
      }
      const p = PQ.quickTake(i, acc, a.order);
      return p ? `${acc} ${p.type} @ ${fmt(p.entry)} ✓` : null;
    }
    if (t === 'trade') {
      if (!loadedNow()) throw new Error('chart not loaded');
      const dir = /sell|short/i.test(a.dir) ? 'short' : 'long', sg = dir === 'long' ? 1 : -1;
      const acc = a.account === 'real' ? 'real' : a.account === 'demo' ? 'demo' : S.settings.active;
      if (acc === 'real' && !a.confirmed) { add('ai', 'REAL account trade — confirm?', { acts: [{ label: 'Confirm', act: { ...a, account: 'real', confirmed: true }, primary: true }, { label: 'Use Demo', act: { ...a, account: 'demo' } }] }); return null; }
      const px = S.candles[S.candles.length - 1].close, limit = a.order === 'limit' && +a.entry > 0;
      const entry = limit ? +a.entry : px, sl = +a.sl > 0 ? +a.sl : null, tp = +a.tp > 0 ? +a.tp : null;
      if (sl != null && (entry - sl) * sg <= 0) throw new Error('SL is on the wrong side');
      if (tp != null && (tp - entry) * sg <= 0) throw new Error('TP is on the wrong side');
      let units = +a.lot > 0 ? PrymeTrade.unitsFromLot(S.market, S.symbol, +a.lot) : null;
      if (!units && sl != null) units = sizingFor(acc, { direction: dir, entry, stopLoss: sl, tp1: tp ?? entry + sg * Math.abs(entry - sl), tp2: tp ?? entry + 2 * sg * Math.abs(entry - sl) }, S.market, S.symbol).units;
      if (!units) units = PrymeTrade.unitsFromLot(S.market, S.symbol, PrymeTrade.getLot());
      const pos = createPosition(acc, { direction: dir, name: 'Agent', tp3: null }, { entry, sl, tp1: null, tp2: tp, units, market: !limit });
      pos.manual = true; if (!limit) pos.entry = px; saveAccounts();
      try { drawPositions(); renderAccounts(); renderAcctCard(); PrymeTrade.render(); } catch { }
      return `${acc} ${dir === 'long' ? 'BUY' : 'SELL'} ${limit ? 'limit ' : ''}@ ${fmt(entry)} ✓`;
    }
    if (t === 'close') {
      const tg = String(a.target || 'all').toUpperCase(); let n = 0;
      ['demo', 'real'].forEach(acc => [...S.accounts[acc].positions].forEach(p => {
        const match = tg === 'ALL' || (tg === 'SYMBOL' && p.symbol === S.symbol.toUpperCase()) || p.symbol === tg || p.code === tg || ('#' + tg) === p.code;
        if (!match) return;
        if (p.status === 'pending') { S.accounts[acc].positions = S.accounts[acc].positions.filter(x => x.id !== p.id); n++; return; }
        const q = S.livePrices[p.market + '|' + p.symbol]; if (q == null) return;
        closePart(p, q, p.remaining, 'Closed by agent'); n++;
      }));
      saveAccounts(); try { renderAccounts(); renderAcctCard(); PrymeTrade.render(); } catch { }
      return n ? `closed ${n}` : 'nothing to close (or no live price yet)';
    }
    if (t === 'alert') {
      const price = +a.price, px = S.candles.length ? S.candles[S.candles.length - 1].close : null;
      if (!(price > 0) || px == null) throw new Error('bad alert price');
      alerts.push({ id: Date.now(), market: S.market, symbol: S.symbol.toUpperCase(), price, dir: price >= px ? 'above' : 'below', note: String(a.note || '').slice(0, 80) });
      saveAlerts(); return `alert at ${fmt(price)} set 🔔`;
    }
    if (t === 'watch') {
      const w = { market: ['forex', 'crypto', 'stock', 'cse'].includes(a.market) ? a.market : S.market, symbol: String(a.symbol || S.symbol).toUpperCase(), tf: okTf(a.tf) && a.tf !== '1m' ? a.tf : (S.tf === '1m' ? '5m' : S.tf) };
      if (!S.settings.agentWatch.some(x => x.symbol === w.symbol && x.tf === w.tf)) S.settings.agentWatch.push(w);
      S.settings.agentWatch = S.settings.agentWatch.slice(-8); saveSettings(); renderWatch(); register();
      return `watching ${w.symbol} ${w.tf.toUpperCase()}${S.settings.notif.agent ? '' : ' (turn on Agent alerts in Account for phone notifications)'}`;
    }
    if (t === 'unwatch') {
      const s = String(a.symbol || '').toUpperCase();
      S.settings.agentWatch = S.settings.agentWatch.filter(x => x.symbol !== s); saveSettings(); renderWatch(); register();
      return `stopped watching ${s}`;
    }
    if (t === 'tab') { setTab(a.tab); return null; }
    if (t === 'theme') { PQ.setTheme(a.value === 'light' ? 'light' : 'dark'); return 'theme changed'; }
    if (t === 'indicator') {
      if (!(a.name in S.settings.ind)) throw new Error('unknown indicator');
      S.settings.ind[a.name] = a.on !== false; saveSettings(); PrymeChart.updateIndicators(); return `${a.name} ${a.on !== false ? 'on' : 'off'}`;
    }
    if (t === 'risk') { const v = Math.max(0.1, Math.min(10, +a.value || 1)); S.settings.riskPct = v; saveSettings(); $('#riskInput').value = v; return `risk ${v}%`; }
    if (t === 'backtest') { runBacktest(); return 'backtest opened'; }
    return null;
  }
  box.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const el = b.closest('.msg'), m = chat[+el.dataset.i]; if (!m || !m.acts) return;
    const a = m.acts[+b.dataset.act]; m.done = '…'; render(false);
    act(a.act, m).then(r => { m.done = r || '✓'; save(); render(); }).catch(err => { m.done = '⚠ ' + err.message; save(); render(); });
  };

  /* ---------- input ---------- */
  const ta = $('#agText');
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); send(ta.value); } });
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
  $('#agForm').onsubmit = e => { e.preventDefault(); send(ta.value); };
  $('#agClear').onclick = async () => { if (await askUser('Clear the chat?', 'Messages are removed from this account.', 'Clear', true)) { chat = []; save(); render(); } };

  /* ---------- price alerts (checked on every live tick) ---------- */
  function checkAlerts() {
    if (!alerts.length) return;
    let hit = false;
    alerts = alerts.filter(a => {
      const q = S.livePrices[a.market + '|' + a.symbol]; if (q == null) return true;
      if ((a.dir === 'above' && q >= a.price) || (a.dir === 'below' && q <= a.price)) {
        hit = true;
        notify(`🔔 ${a.symbol} ${a.dir === 'above' ? '≥' : '≤'} ${fmt(a.price)}`, a.note || `Price is now ${fmt(q)}`, 'entries', `/?tab=home&market=${a.market}&symbol=${a.symbol}`);
        add('ai', `🔔 **${a.symbol}** reached **${fmt(a.price)}** (now ${fmt(q)}).${a.note ? '\n' + a.note : ''}`);
        if (document.body.dataset.tab !== 'agent') $('#navAgDot').classList.remove('hidden');
        return false;
      }
      return true;
    });
    if (hit) saveAlerts();
  }
  const _tick = onTick;
  window.onTick = function (c) { const r = _tick.apply(this, arguments); try { checkAlerts(); } catch { } return r; };

  /* ---------- background watch (server scans + push notifications) ---------- */
  function renderWatch() {
    const W = S.settings.agentWatch;
    $('#agWatchN').textContent = W.length;
    $('#agWatch').innerHTML = `<div class="aw-row"><small>Agent watch list — it scans every few minutes and notifies you about clean setups.</small></div>
      <div class="aw-list">${W.map((w, i) => `<span>${esc(w.symbol)} ${w.tf.toUpperCase()}<button data-unw="${i}" title="Remove">✕</button></span>`).join('') || '<small>Empty</small>'}</div>
      <div class="aw-row"><button class="ghost sm" id="awAdd">+ Add ${esc(S.symbol.toUpperCase())} ${S.tf === '1m' ? '5M' : S.tf.toUpperCase()}</button>
      <label class="acc-row" style="padding:0;border:0;gap:6px">Min grade <select id="awMin"><option value="82">A+</option><option value="70">A</option><option value="60">B</option></select></label>
      <small id="awState">${S.settings.notif.agent ? '🔔 Background alerts ON' : '🔕 Background alerts OFF — turn on in Account → Notifications'}</small></div>`;
    $('#awMin').value = String(S.settings.agentMin);
  }
  $('#agWatch').addEventListener('click', e => {
    const u = e.target.closest('[data-unw]');
    if (u) { S.settings.agentWatch.splice(+u.dataset.unw, 1); saveSettings(); renderWatch(); register(); }
    if (e.target.closest('#awAdd')) act({ type: 'watch' }).then(r => toast(r));
  });
  $('#agWatch').addEventListener('change', e => { if (e.target.id === 'awMin') { S.settings.agentMin = +e.target.value; saveSettings(); register(); } });
  $('#agWatchBtn').onclick = () => { renderWatch(); $('#agWatch').classList.toggle('hidden'); };

  const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
  async function pushSub() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const k = await getJSON('/api/push/key').catch(() => null); if (!k || !k.key) return null;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && store.get('pa_push_key', '') !== k.key) { try { await sub.unsubscribe(); } catch { } sub = null; } // server keys changed → subscribe again
    if (!sub) { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) }); store.set('pa_push_key', k.key); }
    return sub.toJSON();
  }
  let regT = null;
  async function register() {
    clearTimeout(regT);
    const on = !!S.settings.notif.agent;
    let sub = null;
    if (on && 'Notification' in window && Notification.permission === 'granted') { try { sub = await pushSub(); } catch (e) { console.warn('push subscribe', e); } }
    try {
      await getJSON('/api/agent/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: AG_ID, enabled: on, sub, watch: S.settings.agentWatch, lang: S.settings.lang, minScore: S.settings.agentMin,
        keys: on ? keys().slice(0, 3) : [], name: window.PrymeCloud?.getProfile?.().name || ''
      }) });
    } catch { }
    regT = setTimeout(register, 10 * 60 * 1000);
    return !!sub;
  }
  async function setBackground(on) {
    if (on) {
      const ok = await PQ.askPermission();
      if (!S.settings.agentWatch.length) { S.settings.agentWatch.push({ market: S.market, symbol: S.symbol.toUpperCase(), tf: S.tf === '1m' ? '5m' : S.tf }); saveSettings(); }
      const pushed = await register();
      toast(pushed ? 'Agent alerts ON — you get a notification even when the app is closed' : ok ? 'Agent alerts ON while Pryme is open (this browser cannot receive background push)' : 'Agent alerts ON inside the app — allow notifications for phone alerts', 4200);
      renderWatch(); return pushed;
    }
    await register(); renderWatch(); return true;
  }
  async function testPush() {
    try { await getJSON('/api/agent/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: AG_ID }) }); }
    catch (e) { toast(e.message, 4000); }
  }
  // the agent's finds also appear in the chat (and as an in-app notification when push is not available)
  let seen = store.get('pa_agent_seen', 0);
  async function pollAlerts() {
    if (!S.settings.notif.agent || document.hidden) return;
    try {
      const st = await getJSON('/api/agent/status?id=' + AG_ID);
      if (!st.registered) { register(); return; }
      const fresh = (st.alerts || []).filter(a => a.t > seen).reverse();
      fresh.forEach(a => {
        add('ai', `🎯 **${a.symbol} ${a.tf.toUpperCase()} · ${a.dir}** (${a.grade})\nLimit **${fmt(a.limit, 5).replace(/\.?0+$/, '')}** · now ${fmt(a.price, 5).replace(/\.?0+$/, '')} · SL ${fmt(a.sl, 5).replace(/\.?0+$/, '')} · TP ${fmt(a.tp1, 5).replace(/\.?0+$/, '')}${a.why ? '\n' + a.why : ''}`,
          { acts: [{ label: 'Open & full check', act: { type: 'load', market: a.market, symbol: a.symbol, tf: a.tf }, primary: true }] });
        if (!st.push) notify(a.title, a.body, 'agent', `/?tab=signals&market=${a.market}&symbol=${a.symbol}&tf=${a.tf}&go=1`);
        if (document.body.dataset.tab !== 'agent') $('#navAgDot').classList.remove('hidden');
      });
      if (fresh.length) { seen = Math.max(...fresh.map(a => a.t)); store.set('pa_agent_seen', seen); }
      const ago = st.lastScan ? Math.round((Date.now() - st.lastScan) / 60000) : null;
      $('#agStatus').textContent = `Watching ${S.settings.agentWatch.length} · ${ago == null ? 'first scan soon' : 'last scan ' + ago + ' min ago'}`;
    } catch { }
  }
  setInterval(pollAlerts, 60000);

  window.PrymeAgent = { send, setBackground, testPush, register, opened: () => { render(); renderWatch(); setTimeout(() => ta.focus({ preventScroll: true }), 50); pollAlerts(); } };
  render(false); renderWatch();
  $('#agStatus').textContent = keys().length ? 'Online · uses your AI keys' : 'Simple mode — add an AI key for full chat';
  if (S.settings.notif.agent) setTimeout(register, 3000);
})();

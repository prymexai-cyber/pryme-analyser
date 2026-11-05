/* ============================================================
   PRYME QUANT — app shell
   Home · Signals · Agent · Account (sidebar on desktop, bottom bar on phones)
   theme + accent, notifications, time zone, invite, limit/market entry sheet
   ============================================================ */
'use strict';
(() => {
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const tb = $('.topbar'); if (tb && !$('#pageTitle')) tb.insertAdjacentHTML('afterbegin', '<div class="page-title" id="pageTitle">Home</div>');
  S.settings.notif = Object.assign({ entries: true, tpsl: true, agent: false, sound: true }, S.settings.notif || {});
  if (!S.settings.tz) S.settings.tz = 'Asia/Colombo';
  if (!S.settings.entryStyle) S.settings.entryStyle = 'ask';
  if (!S.settings.appTheme) S.settings.appTheme = 'dark';

  /* ---------- small helpers ---------- */
  function askUser(title, text, ok = 'OK', danger = false) {
    return new Promise(res => {
      const sh = $('#askSheet'); $('#askTitle').textContent = title; $('#askText').textContent = text || '';
      const b = $('#askOk'); b.textContent = ok; b.style.background = danger ? 'var(--short)' : ''; b.style.color = danger ? '#fff' : '';
      sh.classList.remove('hidden');
      const done = v => { sh.classList.add('hidden'); sh.onclick = null; b.onclick = null; res(v); };
      b.onclick = () => done(true);
      sh.onclick = e => { if (e.target === sh || e.target.closest('[data-close]')) done(false); };
    });
  }
  window.askUser = askUser;
  $$('.sheet').forEach(sh => sh.addEventListener('click', e => { if (sh.id !== 'askSheet' && (e.target === sh || e.target.closest('[data-close]'))) sh.classList.add('hidden'); }));
  const waitFor = (fn, ms = 20000) => new Promise(res => { const t0 = Date.now(); const k = setInterval(() => { if (fn() || Date.now() - t0 > ms) { clearInterval(k); res(fn()); } }, 150); });

  /* ---------- tabs ---------- */
  const TABS = ['home', 'signals', 'agent', 'account'];
  const TITLES = { home: 'Home', signals: 'Signals', agent: 'Agent', account: 'Account' };
  const LEGACY = { live: 'home', trades: 'home', user: 'account' };
  function placeChart(tab) {
    const slot = tab === 'signals' ? $('#slotSignals') : tab === 'home' ? $('#slotHome') : null;
    const blk = $('#chartBlock');
    if (slot && blk.parentElement !== slot) { slot.appendChild(blk); blk.classList.add('placed'); }
  }
  function setTab(tab) {
    tab = LEGACY[tab] || tab; if (!TABS.includes(tab)) tab = 'home';
    document.body.dataset.tab = tab;
    placeChart(tab);
    $('#pageTitle').textContent = TITLES[tab];
    try { sessionStorage.setItem('pq_tab', tab); } catch { }
    $$('#bottomNav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'home') { try { renderTradePanel(); renderAccounts(); } catch { } }
    if (tab === 'signals') { syncSignalCard(); $('#navSigDot').classList.add('hidden'); }
    if (tab === 'account') renderAccountPage();
    if (tab === 'agent') { $('#navAgDot').classList.add('hidden'); window.PrymeAgent?.opened(); }
    window.scrollTo({ top: 0 });
    setTimeout(() => { try { window.dispatchEvent(new Event('resize')); drawBoxes(); window.PrymeChart?.render(); } catch { } }, 60);
  }
  window.setTab = setTab;
  $('#bottomNav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });

  // nav dots: running trades (Home), live signals (Signals)
  setInterval(() => {
    try {
      const n = S.accounts.demo.positions.length + S.accounts.real.positions.length;
      $('#navLiveDot').classList.toggle('hidden', !n || document.body.dataset.tab === 'home');
    } catch { }
  }, 2000);

  /* ---------- theme & accent ---------- */
  const ACCENTS = [
    { id: 'lime', c: '#c6ff3d', ink: '#4f8a00' }, { id: 'cyan', c: '#3de0ff', ink: '#0086a8' }, { id: 'gold', c: '#f6c24a', ink: '#a86f00' },
    { id: 'violet', c: '#a78bfa', ink: '#6d28d9' }, { id: 'pink', c: '#ff6bcb', ink: '#c0267f' }, { id: 'blue', c: '#4e8bff', ink: '#1d4ed8' }
  ];
  const sysLight = window.matchMedia('(prefers-color-scheme: light)');
  const themeNow = () => S.settings.appTheme === 'system' ? (sysLight.matches ? 'light' : 'dark') : S.settings.appTheme;
  function applyAppTheme(followChart) {
    const t = themeNow(), a = ACCENTS.find(x => x.id === S.settings.accent) || ACCENTS[0];
    const root = document.documentElement; root.dataset.theme = t;
    root.style.setProperty('--brand', t === 'light' ? a.ink : a.c);
    const m = $('meta[name=theme-color]'); if (m) m.content = t === 'light' ? '#f3f5f9' : '#07090d';
    if (followChart && window.PrymeChart) PrymeChart.applyTheme(t === 'light' ? 'light' : 'dark');
    $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.th === S.settings.appTheme));
    $$('#chartSeg button').forEach(b => b.classList.toggle('on', b.dataset.ch === (document.body.dataset.chart || 'light')));
    $('#accentPick').innerHTML = ACCENTS.map(x => `<button data-ac="${x.id}" class="${x.id === a.id ? 'on' : ''}" style="background:${x.c}" title="${x.id}"></button>`).join('');
  }
  sysLight.addEventListener?.('change', () => { if (S.settings.appTheme === 'system') applyAppTheme(true); });
  window.PQ = Object.assign(window.PQ || {}, { setTheme: v => { S.settings.appTheme = v; saveSettings(); applyAppTheme(true); }, setTab, askUser });

  /* ---------- time zone on the chart ---------- */
  const TZS = ['Asia/Colombo', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'UTC'];
  function applyTz() {
    const tz = S.settings.tz || 'Asia/Colombo', daily = S.tf === '1d';
    const mk = o => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: daily ? 'UTC' : tz, ...o }); } catch { return new Intl.DateTimeFormat('en-GB', o); } };
    const fT = mk({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), fD = mk({ day: 'numeric', month: 'short' }), fDn = mk({ day: 'numeric' }),
      fM = mk({ month: 'short' }), fY = mk({ year: 'numeric' }), fFull = mk(daily ? { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' } : { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    try {
      chart.applyOptions({
        localization: { timeFormatter: t => fFull.format(t * 1000) },
        timeScale: { tickMarkFormatter: (t, type) => { const d = t * 1000; return type === 0 ? fY.format(d) : type === 1 ? fM.format(d) : type === 2 ? (daily ? fD.format(d) : fDn.format(d)) : fT.format(d); } }
      });
    } catch { }
  }
  window.PQ.applyTz = applyTz;

  /* ---------- signals tab: one-click timeframe signal ---------- */
  function syncSignalCard() {
    $('#sigSym').textContent = `${S.symbol.toUpperCase()} · ${S.tf.toUpperCase()}`;
    $$('#sigTf button').forEach(b => b.classList.toggle('on', b.dataset.stf === S.tf));
    $('#entryStyle').value = S.settings.entryStyle;
  }
  async function oneClickSignal(tf) {
    const btn = $(`#sigTf [data-stf="${tf}"]`); btn?.classList.add('busy');
    try {
      if (S.tf !== tf) {
        setTF(tf); syncSignalCard();
        await waitFor(() => S.tf === tf && S.candles.length && S.loadedKey === `${S.market}|${S.symbol.toUpperCase()}`);
      }
      await runAnalysis();
      $('#resultCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally { btn?.classList.remove('busy'); syncSignalCard(); }
  }
  window.PQ.oneClickSignal = oneClickSignal;
  $('#sigTf').onclick = e => { const b = e.target.closest('[data-stf]'); if (b) oneClickSignal(b.dataset.stf); };
  $('#entryStyle').onchange = e => { S.settings.entryStyle = e.target.value; saveSettings(); };

  /* ---------- entry sheet: limit or market ---------- */
  let esIdx = null, esAcc = 'demo';
  function units(acc, s, entry) {
    const z = sizingFor(acc, { ...s, entry }, S.market, S.symbol);
    return S.market === 'crypto' || S.market === 'forex' ? +(+z.units).toFixed(6) : Math.floor(z.units);
  }
  function quickTake(i, acc, mode) {
    const s = S.setups[i]; if (!s || !S.candles.length) return toast('Get a signal first');
    const price = S.candles[S.candles.length - 1].close, sg = s.direction === 'long' ? 1 : -1;
    const entry = mode === 'market' ? price : s.entry;
    if (mode === 'market' && ((price - s.stopLoss) * sg <= 0 || (s.tp1 - price) * sg <= 0)) return toast('Price already passed SL or TP1 — use a limit entry');
    const u = units(acc, s, entry);
    if (!(u > 0)) return toast('Balance too small for this setup — edit the balance');
    const pos = createPosition(acc, s, { entry, sl: s.stopLoss, tp1: s.tp1, tp2: s.tp2, units: u, market: mode === 'market' });
    addLog(`${ACC_LABEL[acc]}: ${pos.type} ${pos.symbol} @ ${fmt(pos.entry)} · SL ${fmt(s.stopLoss)} · TP ${fmt(s.tp1)}/${fmt(s.tp2)}`);
    toast(`${ACC_LABEL[acc]} · ${pos.status === 'open' ? 'trade opened' : pos.type + ' placed'}${acc === 'real' ? ' — place the same order at your broker' : ''}`, acc === 'real' ? 4200 : 2600);
    setAcctView(acc); renderAccounts(); renderAcctCard(); try { renderTradePanel(); } catch { }
    return pos;
  }
  window.PQ.quickTake = quickTake;
  function fillSheet() {
    const s = S.setups[esIdx]; if (!s) return;
    const price = S.candles[S.candles.length - 1].close, sg = s.direction === 'long' ? 1 : -1, side = s.direction === 'long' ? 'BUY' : 'SELL';
    const ot = orderTypeOf(s, price, S.ind.atr);
    $('#esTitle').textContent = `${side} ${S.symbol.toUpperCase()} · setup #${esIdx + 1}`;
    $('#esSub').textContent = `SL ${fmt(s.stopLoss)} · TP1 ${fmt(s.tp1)} · TP2 ${fmt(s.tp2)}${s.grade ? ' · grade ' + s.grade : ''}`;
    $$('#esAcc button').forEach(b => b.classList.toggle('on', b.dataset.a === esAcc));
    const uL = units(esAcc, s, s.entry), uM = units(esAcc, s, price), cs = contractSize(S.market, S.symbol);
    const sz = u => cs > 1 ? `${(u / cs).toFixed(2)} lot` : `${+u.toFixed(4)}`;
    $('#esLimit').textContent = `${ot.startsWith('MARKET') ? side + ' @' : ot} ${fmt(s.entry)} · ${sz(uL)}`;
    $('#esMarket').textContent = `${side} @ ${fmt(price)} · ${sz(uM)}`;
    const mOk = (price - s.stopLoss) * sg > 0 && (s.tp1 - price) * sg > 0;
    $('#entrySheet [data-mode=market]').disabled = !mOk;
    const w = [];
    if (!mOk) w.push('Market entry not possible — price is already past SL or TP1.');
    if (s.ok === false) w.push('Watch-only setup: not every pro check passed.');
    const g = riskGuard(); if (g.block) w.push(g.why);
    $('#esWarn').textContent = w.join(' '); $('#esWarn').classList.toggle('hidden', !w.length);
  }
  window.openEntrySheet = i => {
    if (!S.setups[i]) return;
    const st = S.settings.entryStyle;
    if (st === 'limit' || st === 'market') return quickTake(i, S.settings.active, st);
    esIdx = i; esAcc = S.settings.active; fillSheet(); $('#entrySheet').classList.remove('hidden');
  };
  $('#esAcc').onclick = e => { const b = e.target.closest('[data-a]'); if (b) { esAcc = b.dataset.a; fillSheet(); } };
  $('#entrySheet').addEventListener('click', e => {
    const o = e.target.closest('[data-mode]'); if (o) { $('#entrySheet').classList.add('hidden'); quickTake(esIdx, esAcc, o.dataset.mode); }
  });
  $('#esEdit').onclick = () => { $('#entrySheet').classList.add('hidden'); openTradeModal(esIdx, esAcc); };

  /* ---------- account page ---------- */
  const cloud = () => window.PrymeCloud || {};
  function renderAccountPage() {
    const C = cloud(), p = C.getProfile ? C.getProfile() : {};
    $('#accAvatar').innerHTML = C.avatarHTML ? C.avatarHTML(p, 52) : '';
    $('#accName').textContent = p.name || 'Trader';
    $('#accEmail').textContent = C.user ? C.user.email : (C.fbReady ? 'Not signed in' : 'Saved on this device only');
    $('#accLogout').classList.toggle('hidden', !C.user);
    $('#accLogin').classList.toggle('hidden', !!C.user);
    ['demo', 'real'].forEach(a => {
      const A = S.accounts[a], k = a === 'demo' ? 'Demo' : 'Real';
      $(`#bc${k}USD`).textContent = money(A.USD, 'USD'); $(`#bc${k}LKR`).textContent = money(A.LKR, 'LKR') + ' · CSE';
      const card = $(`.bal-card[data-bal=${a}]`), on = S.settings.active === a;
      card.classList.toggle('active', on); card.querySelector('.bc-use').textContent = on ? 'Active' : 'Use';
    });
    const N = S.settings.notif;
    $('#nfEntries').checked = N.entries; $('#nfTpsl').checked = N.tpsl; $('#nfAgent').checked = N.agent; $('#nfSound').checked = N.sound;
    $('#tzSel').innerHTML = [...new Set([S.settings.tz, ...TZS, Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean))]
      .map(z => `<option value="${z}" ${z === S.settings.tz ? 'selected' : ''}>${z.replace('_', ' ')}</option>`).join('');
    $('#langSel2').value = S.settings.lang;
    applyAppTheme(false);
  }
  window.addEventListener('pq:profile', () => { if (document.body.dataset.tab === 'account') renderAccountPage(); });
  $('#accEdit').onclick = () => $('#pmEdit').click();
  $('.acc-bals').onclick = e => {
    const u = e.target.closest('[data-use]'), ed = e.target.closest('[data-editbal]');
    if (u) { setActive(u.dataset.use); renderAccountPage(); toast(`${ACC_LABEL[u.dataset.use]} account is active`); }
    if (ed) openBalModal(ed.dataset.editbal);
  };
  $('#bmSave').addEventListener('click', () => setTimeout(() => { if (document.body.dataset.tab === 'account') renderAccountPage(); }, 50));
  $('#themeSeg').onclick = e => { const b = e.target.closest('[data-th]'); if (b) { S.settings.appTheme = b.dataset.th; saveSettings(); applyAppTheme(true); } };
  $('#chartSeg').onclick = e => { const b = e.target.closest('[data-ch]'); if (b) { PrymeChart.applyTheme(b.dataset.ch); applyAppTheme(false); } };
  $('#accentPick').onclick = e => { const b = e.target.closest('[data-ac]'); if (b) { S.settings.accent = b.dataset.ac; saveSettings(); applyAppTheme(false); } };
  async function askPermission() {
    if (!('Notification' in window)) { toast('This browser cannot show notifications'); return false; }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') { toast('Notifications are blocked — allow them in the browser / app settings'); return false; }
    return (await Notification.requestPermission()) === 'granted';
  }
  window.PQ.askPermission = askPermission;
  [['#nfEntries', 'entries'], ['#nfTpsl', 'tpsl'], ['#nfSound', 'sound']].forEach(([id, k]) => {
    $(id).onchange = async e => { S.settings.notif[k] = e.target.checked; saveSettings(); if (e.target.checked && k !== 'sound') await askPermission(); };
  });
  $('#nfAgent').onchange = async e => {
    const on = e.target.checked; S.settings.notif.agent = on; saveSettings();
    if (window.PrymeAgent) { const r = await PrymeAgent.setBackground(on); if (on && r === false) { /* stays on: in-app alerts still work */ } }
  };
  $('#nfTest').onclick = async () => {
    if (!(await askPermission())) return;
    notify('Pryme Quant ✓', 'Notifications are working on this device.', 'test');
    if (S.settings.notif.agent && window.PrymeAgent) PrymeAgent.testPush();
  };
  $('#tzSel').onchange = e => { S.settings.tz = e.target.value; saveSettings(); applyTz(); toast('Chart time: ' + e.target.value); };
  $('#langSel2').onchange = e => { S.settings.lang = e.target.value; saveSettings(); };
  $('.page[data-page=account]').addEventListener('click', e => {
    const o = e.target.closest('[data-open]'); if (!o) return;
    const k = o.dataset.open;
    if (k === 'keys') $('#btnSettings').click();
    if (k === 'help') $('#pmHelp').click();
    if (k === 'install') install();
    if (k === 'invite') openInvite();
    if (k === 'history') { setTab('home'); setAcctTab('hist'); setTimeout(() => $('#acctSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }
  });
  $('#accLogout').onclick = async () => {
    if (!(await askUser('Log out?', 'Your data stays saved in your Google account and comes back when you sign in again.', 'Log out', true))) return;
    cloud().signOut?.(true);
  };
  $('#accLogin').onclick = () => cloud().signIn ? cloud().signIn() : $('#pmSignIn').click();
  $('#demoChip').onclick = () => setTab('account');

  /* ---------- invite friends ---------- */
  const shareText = () => `Pryme Quant — AI trading signals for Forex, Gold, Crypto, Stocks & CSE 🇱🇰 with a free demo account. Try it:`;
  const shareUrl = () => location.origin + '/';
  function openInvite() {
    const t = encodeURIComponent(shareText()), u = encodeURIComponent(shareUrl()), tu = encodeURIComponent(shareText() + ' ' + shareUrl());
    const L = { whatsapp: `https://wa.me/?text=${tu}`, telegram: `https://t.me/share/url?url=${u}&text=${t}`, facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`, x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`, sms: `sms:?&body=${tu}` };
    $$('#inviteSheet a[data-share]').forEach(a => a.href = L[a.dataset.share]);
    $('#shareNative').classList.toggle('hidden', !navigator.share);
    $('#inviteSheet').classList.remove('hidden');
  }
  $('#inviteSheet [data-share=copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(shareText() + ' ' + shareUrl()); toast('Invite link copied'); } catch { toast(shareUrl()); }
  };
  $('#shareNative').onclick = () => navigator.share?.({ title: 'Pryme Quant', text: shareText(), url: shareUrl() }).catch(() => { });

  /* ---------- installable app ---------- */
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#accInstall').classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { $('#accInstall').classList.add('hidden'); toast('Pryme Quant installed 🎉'); });
  if (standalone) { $('#accInstall').classList.add('hidden'); document.body.classList.add('is-app'); }
  async function install() {
    if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch { } deferred = null; return; }
    $('#installModal').classList.remove('hidden');
  }

  /* ---------- keep everything in step with chart changes ---------- */
  const _load = loadMarket;
  window.loadMarket = async function (...a) {
    applyTz();
    const r = await _load.apply(this, a);
    if (document.body.dataset.tab === 'signals') syncSignalCard();
    return r;
  };
  const _rr = renderResult;
  window.renderResult = function (A) {
    const r = _rr.call(this, A);
    if (A && document.body.dataset.tab !== 'signals') $('#navSigDot').classList.remove('hidden');
    return r;
  };

  /* ---------- start ---------- */
  applyAppTheme(false);
  applyTz();
  let start = 'home', q = null;
  try { q = new URLSearchParams(location.search); start = q.get('tab') || sessionStorage.getItem('pq_tab') || 'home'; } catch { }
  setTab(start);
  // opened from a notification: ?tab=signals&market=forex&symbol=XAUUSD&tf=1h&go=1
  if (q && q.get('symbol')) {
    const m = q.get('market') || S.market, sym = q.get('symbol').toUpperCase(), tf = q.get('tf') || S.tf;
    history.replaceState(null, '', location.pathname + (start !== 'home' ? '?tab=' + start : ''));
    setTimeout(async () => {
      try {
        await switchTo(m, sym, tf);
        if (q.get('go')) { await waitFor(() => S.candles.length && S.loadedKey === `${m}|${sym}`); await runAnalysis(); }
      } catch { }
    }, 600);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open' && e.data.url) location.href = e.data.url; });
  }
})();

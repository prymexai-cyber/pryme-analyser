/* ============================================================
   PRYME QUANT — mobile app shell
   - bottom navigation (Home · Signals · Live · Trades · Account) on phones
   - installable app (PWA): service worker + "Install app" button
   ============================================================ */
'use strict';
(() => {
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  // page title in the top bar (desktop shows it next to the sidebar)
  const tb = $('.topbar'); if (tb && !$('#pageTitle')) tb.insertAdjacentHTML('afterbegin', '<div class="page-title" id="pageTitle">Home</div>');

  /* ---------- tabs ---------- */
  const TABS = ['home', 'signals', 'live', 'account', 'user'];
  const TITLES = { home: 'Home', signals: 'AI Signals', live: 'Live Charts', account: 'Account', user: 'User' };
  function setTab(tab) {
    if (tab === 'trades') tab = 'account';
    if (!TABS.includes(tab)) tab = 'home';
    document.body.dataset.tab = tab;
    const pt = $('#pageTitle'); if (pt) pt.textContent = TITLES[tab];
    try { sessionStorage.setItem('pq_tab', tab); } catch { }
    $$('#bottomNav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'live') { try { setView(); renderTradePanel(); } catch { } }
    if (tab === 'account') { try { renderAccounts(); } catch { } }
    if (tab === 'user') syncMe();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    // let the chart re-measure after its box changed size
    setTimeout(() => { try { window.dispatchEvent(new Event('resize')); drawBoxes(); } catch { } }, 60);
  }
  $('#bottomNav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  let start = 'home'; try { start = new URLSearchParams(location.search).get('tab') || sessionStorage.getItem('pq_tab') || 'home'; } catch { }

  setTab(start);

  // jump to Live after taking a trade on a phone
  document.addEventListener('click', e => {
    if (isPhone() && e.target.closest('#tmConfirm')) setTimeout(() => setTab('live'), 150);
    if (isPhone() && e.target.closest('[data-show]')) setTimeout(() => setTab('live'), 50);
  }, true);

  // dot on "Live" when trades are running
  setInterval(() => {
    try {
      const n = S.accounts.demo.positions.length + S.accounts.real.positions.length;
      $('#navLiveDot').classList.toggle('hidden', !n);
    } catch { }
  }, 2000);

  /* ---------- account tab (mirrors the profile menu) ---------- */
  function syncMe() {
    const a = $('#pmAvatar'); if (!a) return;
    $('#meAvatar').innerHTML = a.innerHTML;
    $('#meName').textContent = $('#pmName').textContent;
    $('#meEmail').textContent = $('#pmEmail').textContent;
    $('#meSignIn').classList.toggle('hidden', $('#pmSignIn').classList.contains('hidden'));
    $('#meSignOut').classList.toggle('hidden', $('#pmSignOut').classList.contains('hidden'));
  }
  setInterval(() => { if (document.body.dataset.tab === 'user') syncMe(); }, 1500);
  $('.me-card').addEventListener('click', e => {
    const b = e.target.closest('[data-me]'); if (!b) return;
    const act = b.dataset.me;
    if (act === 'profile') $('#pmEdit').click();
    if (act === 'keys') $('#btnSettings').click();
    if (act === 'help') $('#pmHelp').click();
    if (act === 'signin') $('#pmSignIn').click();
    if (act === 'signout') $('#pmSignOut').click();
    if (act === 'install') install();
  });

  /* ---------- installable app ---------- */
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#meInstall').classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { $('#meInstall').classList.add('hidden'); toast('Pryme Quant installed 🎉'); });
  if (!standalone) $('#meInstall').classList.remove('hidden');
  async function install() {
    if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch { } deferred = null; return; }
    $('#installModal').classList.remove('hidden');
  }
  if (standalone) document.body.classList.add('is-app');
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
})();

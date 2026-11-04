/* ============================================================
   PRYME — Google login, cloud save (Firebase), profile, welcome guide
   - Login with Google (Firebase Auth)
   - All your data (accounts, trades, signals, settings, AI keys, profile) is saved to
     Firestore under your own account, so it survives Render restarts and works on every device.
   - Without Firebase config the app still works in "this device only" mode.
   ============================================================ */
'use strict';
(() => {
  const SYNC_KEYS = ['pa_settings', 'pa_accounts', 'pa_signals', 'pa_sigstats', 'pa_batch', 'pa_log', 'pa_events', 'pa_profile', 'pa_market', 'pa_tf', 'pa_view', 'pa_view2', 'pa_seq', 'pa_hperiod'];
  const raw = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } };
  const device = raw('pa_device') || (() => { const d = Math.random().toString(36).slice(2, 10); put('pa_device', d); return d; })();

  const C = { booting: true, fb: null, auth: null, db: null, user: null, ready: false, guest: false, saveT: null, saving: false, unsub: null };
  window.PrymeCloud = C;

  /* ---------- profile ---------- */
  const AVATARS = [
    { e: '🦁', c: '#f6c24a' }, { e: '🐂', c: '#19e3a2' }, { e: '🐻', c: '#ff4d6d' }, { e: '🦅', c: '#4ea8ff' },
    { e: '🐺', c: '#b07cff' }, { e: '🚀', c: '#c6ff3d' }, { e: '💎', c: '#4ee6ff' }, { e: '🔥', c: '#ff8a3d' }
  ];
  const getProfile = () => { try { return JSON.parse(raw('pa_profile')) || {}; } catch { return {}; } };
  const setProfile = p => { store.set('pa_profile', p); renderProfile(); };
  function initials(name) { return (name || 'P').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || 'P'; }
  function avatarHTML(p, size = 34) {
    const a = p.avatar || {};
    const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px`;
    if (a.type === 'img' && a.src) return `<span class="ava" style="${st}"><img src="${esc(a.src)}" alt=""></span>`;
    if (a.type === 'emoji') return `<span class="ava" style="${st};background:${a.color}22;box-shadow:inset 0 0 0 1px ${a.color}66">${a.emoji}</span>`;
    return `<span class="ava ini" style="${st};font-size:${Math.round(size * 0.4)}px">${esc(initials(p.name))}</span>`;
  }
  function renderProfile() {
    const p = getProfile();
    const btn = $('#profileBtn'); if (!btn) return;
    btn.innerHTML = avatarHTML(p, 34);
    $('#pmAvatar').innerHTML = avatarHTML(p, 52);
    $('#pmName').textContent = p.name || 'Trader';
    $('#pmEmail').textContent = C.user ? C.user.email : (C.fbReady ? 'Not signed in' : 'Saved on this device only');
    $('#pmSignIn').classList.toggle('hidden', !!C.user); // always offer Google sign-in when signed out
    $('#pmSignOut').classList.toggle('hidden', !C.user);
    const hi = $('#helloName'); if (hi) hi.textContent = p.name ? `Hi, ${p.name.split(' ')[0]}` : '';
  }

  /* ---------- sync indicator ---------- */
  function syncState(s) {
    const el = $('#syncPill'); if (!el) return;
    const map = { saved: ['Saved', 'ok'], saving: ['Saving…', ''], offline: ['Offline', 'bad'], local: ['This device', ''], error: ['Save failed', 'bad'] };
    const [t, cls] = map[s] || map.local;
    el.className = 'sync-pill ' + cls; el.querySelector('span').textContent = t;
  }

  /* ---------- cloud save ---------- */
  const origSet = store.set.bind(store);
  store.set = (k, v) => {
    const before = raw(k);
    origSet(k, v);
    // only real changes count, and nothing counts while we're still deciding which copy (cloud/local) is newest
    if (SYNC_KEYS.includes(k) && raw(k) !== before && !C.booting) { put('pa_local_ts', String(Date.now())); scheduleSave(); }
  };
  function snapshotData() {
    const data = {}; SYNC_KEYS.forEach(k => { const v = raw(k); if (v != null) data[k] = v; });
    return data;
  }
  function scheduleSave() {
    if (!C.user || !C.db) return;
    syncState('saving');
    clearTimeout(C.saveT);
    C.saveT = setTimeout(() => { C.saveT = null; saveNow(); }, 1500);
  }
  async function saveNow() {
    if (!C.user || !C.db) return;
    const ts = Date.now();
    try {
      await C.db.collection('users').doc(C.user.uid).set({
        data: snapshotData(), updatedAt: ts, device, email: C.user.email || '', name: getProfile().name || ''
      });
      put('pa_cloud_ts', String(ts)); put('pa_local_ts', String(ts));
      syncState('saved');
    } catch (e) {
      console.warn('cloud save failed', e);
      syncState(navigator.onLine ? 'error' : 'offline');
      clearTimeout(C.saveT); C.saveT = setTimeout(() => { C.saveT = null; saveNow(); }, 15000); // retry
    }
  }
  // only flush if there really are unsaved changes waiting
  window.addEventListener('beforeunload', () => { if (C.saveT && C.user) { clearTimeout(C.saveT); C.saveT = null; saveNow(); } });
  window.addEventListener('online', () => { if (C.user) saveNow(); });

  function applyCloud(doc) {
    // replace this browser's data with the cloud copy, then reload so every part of the app uses it
    SYNC_KEYS.forEach(k => put(k, null));
    Object.entries(doc.data || {}).forEach(([k, v]) => { if (SYNC_KEYS.includes(k)) put(k, v); });
    put('pa_cloud_ts', String(doc.updatedAt || Date.now())); put('pa_local_ts', String(doc.updatedAt || Date.now()));
    location.reload();
  }
  async function onSignedIn(user) {
    C.user = user;
    const uidBefore = raw('pa_uid');
    showGate('loading', 'Loading your data…');
    try {
      const snap = await C.db.collection('users').doc(user.uid).get();
      const doc = snap.exists ? snap.data() : null;
      if (uidBefore && uidBefore !== user.uid) {
        // this browser had another person's data → never mix it
        put('pa_uid', user.uid);
        if (doc) return applyCloud(doc);
        SYNC_KEYS.forEach(k => put(k, null)); location.reload(); return;
      }
      put('pa_uid', user.uid);
      const cloudTs = doc?.updatedAt || 0, syncedTs = +raw('pa_cloud_ts') || 0, localTs = +raw('pa_local_ts') || 0;
      if (doc && cloudTs > syncedTs && !(localTs > syncedTs && localTs > cloudTs)) return applyCloud(doc);
      // first login (or newer changes on this device) → upload
      const p = getProfile();
      if (!p.name || !p.avatar) {
        origSet('pa_profile', { name: p.name || user.displayName || 'Trader', avatar: p.avatar || (user.photoURL ? { type: 'img', src: user.photoURL } : null) });
      }
      C.booting = false;
      await saveNow();
      startLiveSync();
      hideGate(); renderProfile(); maybeWelcome();
    } catch (e) {
      console.error(e);
      showGate('error', 'Could not load your data: ' + (e.message || e) + '. Check the Firestore setup (README) and try again.');
    }
  }
  function startLiveSync() {
    if (C.unsub) C.unsub();
    C.unsub = C.db.collection('users').doc(C.user.uid).onSnapshot(s => {
      const d = s.data(); if (!d) return;
      if (d.device !== device && d.updatedAt > (+raw('pa_cloud_ts') || 0)) {
        const b = $('#syncBanner'); b.classList.remove('hidden');
        b.onclick = () => applyCloud(d);
      }
    }, () => { });
  }

  /* ---------- gate (login screen) ---------- */
  function showGate(mode, msg) {
    const g = $('#gate'); g.classList.remove('hidden');
    $('#gateLoading').classList.toggle('hidden', mode !== 'loading');
    $('#gateLogin').classList.toggle('hidden', mode !== 'login');
    $('#gateMsg').textContent = msg || '';
    $('#gateMsg').classList.toggle('err', mode === 'error');
    if (mode === 'error') $('#gateLogin').classList.remove('hidden');
  }
  function hideGate() { $('#gate').classList.add('hidden'); }
  async function signIn() {
    if (!C.auth) { $('#loginSetupModal').classList.remove('hidden'); return; } // Firebase keys not added on Render yet
    const prov = new firebase.auth.GoogleAuthProvider();
    prov.setCustomParameters({ prompt: 'select_account' });
    try { await C.auth.signInWithPopup(prov); }
    catch (e) {
      if (/popup|cancelled|blocked/i.test(e.code || e.message)) { try { await C.auth.signInWithRedirect(prov); return; } catch (e2) { e = e2; } }
      if (e.code === 'auth/unauthorized-domain') showGate('error', `This website (${location.hostname}) is not allowed yet. In Firebase → Authentication → Settings → Authorized domains, add: ${location.hostname}`);
      else if (e.code !== 'auth/popup-closed-by-user') showGate('error', 'Sign-in failed: ' + (e.message || e));
    }
  }
  async function signOut() {
    if (!confirm('Sign out? Your data stays saved in your Google account and comes back when you sign in again.')) return;
    if (C.saveT) { clearTimeout(C.saveT); C.saveT = null; await saveNow(); }
    if (C.unsub) C.unsub();
    SYNC_KEYS.forEach(k => put(k, null)); put('pa_uid', null); put('pa_cloud_ts', null); put('pa_local_ts', null);
    try { sessionStorage.removeItem('pa_guest'); } catch { }
    await C.auth.signOut();
    location.reload();
  }

  /* ---------- profile modal ---------- */
  let draft = null;
  function openProfile() {
    $('#profileMenu').classList.add('hidden');
    draft = JSON.parse(JSON.stringify(getProfile()));
    $('#pfName').value = draft.name || '';
    renderDraft();
    $('#profileModal').classList.remove('hidden');
    setTimeout(() => $('#pfName').focus(), 50);
  }
  function renderDraft() {
    $('#pfPreview').innerHTML = avatarHTML({ ...draft, name: $('#pfName').value || draft.name }, 84);
    const cur = draft.avatar || {};
    $('#pfAvatars').innerHTML = AVATARS.map((a, i) => `<button type="button" class="ava-pick ${cur.type === 'emoji' && cur.emoji === a.e ? 'on' : ''}" data-av="${i}" style="background:${a.c}22;box-shadow:inset 0 0 0 1px ${a.c}66">${a.e}</button>`).join('')
      + `<button type="button" class="ava-pick ${!cur.type ? 'on' : ''}" data-av="ini" title="Use my initials">${esc(initials($('#pfName').value || draft.name))}</button>`
      + (C.user?.photoURL ? `<button type="button" class="ava-pick" data-av="google" title="Use my Google photo"><img src="${esc(C.user.photoURL)}" alt=""></button>` : '');
  }
  function resizeImage(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          const s = 160, c = document.createElement('canvas'); c.width = c.height = s;
          const m = Math.min(img.width, img.height), sx = (img.width - m) / 2, sy = (img.height - m) / 2;
          c.getContext('2d').drawImage(img, sx, sy, m, m, 0, 0, s, s);
          res(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = rej; img.src = r.result;
      };
      r.onerror = rej; r.readAsDataURL(file);
    });
  }

  /* ---------- welcome guide ---------- */
  function maybeWelcome() { if (!raw('pa_welcomed')) openWelcome(); }
  function openWelcome() { $('#welcomeModal').classList.remove('hidden'); }

  /* ---------- wiring ---------- */
  function wireUI() {
    const d = $('#lsDomain'); if (d) d.textContent = location.hostname;
    $('#profileBtn').onclick = e => { e.stopPropagation(); renderProfile(); $('#profileMenu').classList.toggle('hidden'); };
    document.addEventListener('click', e => { if (!e.target.closest('#profileMenu')) $('#profileMenu').classList.add('hidden'); });
    $('#pmEdit').onclick = openProfile;
    $('#pmHelp').onclick = () => { $('#profileMenu').classList.add('hidden'); openWelcome(); };
    $('#pmSignIn').onclick = () => { $('#profileMenu').classList.add('hidden'); signIn(); };
    $('#pmSignOut').onclick = signOut;
    $('#btnHelp').onclick = openWelcome;
    $('#gateGoogle').onclick = signIn;
    $('#gateGuest').onclick = () => { C.guest = true; C.booting = false; try { sessionStorage.setItem('pa_guest', '1'); } catch { } hideGate(); syncState('local'); maybeWelcome(); };
    $('#pfName').oninput = renderDraft;
    $('#pfAvatars').onclick = e => {
      const b = e.target.closest('[data-av]'); if (!b) return;
      const v = b.dataset.av;
      draft.avatar = v === 'ini' ? null : v === 'google' ? { type: 'img', src: C.user.photoURL } : { type: 'emoji', emoji: AVATARS[+v].e, color: AVATARS[+v].c };
      renderDraft();
    };
    $('#pfUpload').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type)) return toast('Please choose an image file');
      try { draft.avatar = { type: 'img', src: await resizeImage(f) }; renderDraft(); } catch { toast('Could not read that image'); }
      e.target.value = '';
    };
    $('#pfSave').onclick = () => {
      const name = $('#pfName').value.trim().slice(0, 40);
      if (!name) { toast('Please enter a name'); return; }
      setProfile({ ...draft, name });
      $('#profileModal').classList.add('hidden');
      toast('Profile saved');
    };
    $('#wcDone').onclick = () => { put('pa_welcomed', '1'); $('#welcomeModal').classList.add('hidden'); };
    $('#wcKeys').onclick = () => { put('pa_welcomed', '1'); $('#welcomeModal').classList.add('hidden'); $('#btnSettings').click(); };
    $('#wcBalance').onclick = () => { put('pa_welcomed', '1'); $('#welcomeModal').classList.add('hidden'); $('#btnEditBal').click(); };
  }

  /* ---------- start ---------- */
  async function start() {
    wireUI(); renderProfile();
    let cfg = null;
    try { cfg = (await getJSON('/api/config')).firebase; } catch { }
    C.fbReady = !!(cfg && cfg.apiKey && window.firebase);
    if (!C.fbReady) { C.booting = false; syncState('local'); renderProfile(); maybeWelcome(); return; }
    C.fb = firebase.initializeApp(cfg);
    C.auth = firebase.auth(); C.db = firebase.firestore();
    try { C.db.enablePersistence({ synchronizeTabs: true }).catch(() => { }); } catch { }
    let guest = false; try { guest = sessionStorage.getItem('pa_guest') === '1'; } catch { }
    showGate('loading', 'Checking your account…');
    try { await C.auth.getRedirectResult(); } catch (e) { if (e.code === 'auth/unauthorized-domain') showGate('error', `Add ${location.hostname} to Firebase → Authentication → Settings → Authorized domains.`); }
    C.auth.onAuthStateChanged(u => {
      renderProfile();
      if (u) onSignedIn(u);
      else if (guest) { C.booting = false; hideGate(); syncState('local'); }
      else { C.user = null; showGate('login'); }
    });
  }
  start();
})();

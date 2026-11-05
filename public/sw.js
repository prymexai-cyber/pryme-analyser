/* Pryme Quant service worker
   - makes the site installable as an app
   - network-first for the app files (updates show right away), cached copy when offline
   - receives Pryme Agent push notifications (works even when the app is closed)
   Live data (/api/*) and other websites are never cached. */
const CACHE = 'pryme-quant-v4';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/cloud.js', '/chart-tools.js', '/deep.js', '/trade-panel.js', '/shell.js', '/agent.js', '/about.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { })); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});

/* ---- push notifications from Pryme Agent ---- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Pryme Quant', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pryme Agent', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'pryme', renotify: true,
    vibrate: [120, 60, 120], data: { url: d.url || '/?tab=agent' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (new URL(c.url).origin === location.origin) { c.focus(); c.postMessage({ type: 'open', url }); return; }
    }
    return self.clients.openWindow(url);
  }));
});

/* Pryme Quant service worker — makes the site installable as an app.
   Network-first for the app files (so updates show right away), cached copy when offline.
   Live data (/api/*) and other websites are never cached. */
const CACHE = 'pryme-quant-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/cloud.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/maskable-512.png'];
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

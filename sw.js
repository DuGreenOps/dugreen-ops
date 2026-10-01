// App-shell cache so the app opens quickly and installs as a phone app.
// Data always comes live from the server; map tiles are cached as you view them.
const VERSION = 'dg-ops-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/supabase.js',
  'js/app.js', 'js/util.js', 'js/geo.js', 'js/store.js', 'js/config.js', 'js/areas.js', 'js/map.js', 'js/spec.js', 'js/procure.js', 'js/costing.js', 'js/docs.js', 'js/kml.js', 'js/claude.js', 'js/library.js',
  'icons/logo.png', 'icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'dg-tiles').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Map tiles: cache-first (useful on site with patchy signal).
  if (/arcgisonline\.com|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(caches.open('dg-tiles').then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const res = await fetch(e.request); if (res.ok) c.put(e.request, res.clone()); return res;
    }).catch(() => fetch(e.request)));
    return;
  }
  // App files: network-first so updates arrive, fall back to cache offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request)));
  }
});

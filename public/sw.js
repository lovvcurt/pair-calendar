const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
const VERSION = `pair-calendar-shell-${BUILD_ID}`;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(['./', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'])));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache Supabase/API responses or authenticated user data.
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && ((request.mode === 'navigate' && !url.search) || url.pathname.includes('/assets/'))) {
      const copy = response.clone();
      const cacheKey = request.mode === 'navigate' ? new Request(url.origin + url.pathname) : request;
      caches.open(VERSION).then((cache) => cache.put(cacheKey, copy));
    }
    return response;
  }).catch(async () => {
    let cached = await caches.match(request);
    if (!cached && request.mode === 'navigate') cached = await caches.match(new Request(url.origin + url.pathname));
    if (!cached && request.mode === 'navigate') cached = await caches.match('./');
    return cached || Response.error();
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const client = clients.find((entry) => 'focus' in entry);
    return client ? client.focus() : self.clients.openWindow('./');
  }));
});
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

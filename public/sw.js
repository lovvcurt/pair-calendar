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
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data?.text() ?? '' }; }
  const title = typeof payload.title === 'string' ? payload.title : 'Напоминание';
  const body = typeof payload.body === 'string' ? payload.body : 'Откройте календарь, чтобы посмотреть планы.';
  const icon = new URL('icons/icon-192.png', self.registration.scope).href;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { url: typeof payload.url === 'string' ? payload.url : './' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL(event.notification.data?.url ?? './', self.registration.scope);
    if (target.origin !== self.location.origin || !target.href.startsWith(self.registration.scope)) target = new URL(self.registration.scope);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find((entry) => 'focus' in entry);
    if (client) {
      if ('navigate' in client) await client.navigate(target.href);
      await client.focus();
    } else await self.clients.openWindow(target.href);
  })());
});
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

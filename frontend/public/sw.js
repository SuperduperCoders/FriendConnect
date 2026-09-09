// Friendnix Service Worker — v2 (aggressive caching)
const CACHE_NAME = 'friendnix-v2';

// ── Install: skipWaiting so new SW activates immediately ──────────────────────
self.addEventListener('install', () => self.skipWaiting());

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────────────────────────
// Static assets (JS/CSS/images/fonts): cache-first → network fallback
// API / socket / HTML: network-first → cache fallback
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isStaticAsset = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|avif|map)(\?.*)?$/.test(url.pathname);
  const isApiOrSocket = url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io');

  if (isStaticAsset && url.origin === self.location.origin) {
    // Cache-first for local static assets
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
  } else if (isApiOrSocket) {
    // Never intercept API/socket requests
    return;
  } else {
    // Network-first for HTML pages and navigation
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request))
    );
  }
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'Friendnix', body: event.data.text(), url: '/' }; }

  const { title, body, icon, badge, tag, requireInteraction, url } = payload;
  event.waitUntil(self.registration.showNotification(title || 'Friendnix', {
    body: body || '', icon: icon || '/Logo.png', badge: badge || '/Logo.png',
    tag: tag || 'friendnix-notification', requireInteraction: requireInteraction === true,
    renotify: true, data: { url: url || '/' }, vibrate: [150, 50, 150],
    actions: [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }],
  }));
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        try {
          if (new URL(client.url).origin === self.location.origin) {
            client.navigate(targetUrl);
            return client.focus();
          }
        } catch (_) {}
      }
      return clients.openWindow(targetUrl);
    })
  );
});

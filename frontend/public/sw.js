const CACHE_NAME = 'watchsync-v2';

// Static assets to cache on install
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: precache shell ────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: drop old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: routing strategy ───────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache: API calls, WebSocket upgrades, cross-origin requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.origin !== self.location.origin ||
    request.method !== 'GET'
  ) {
    return; // fall through to network
  }

  // Static assets (JS/CSS/images/fonts): cache-first
  if (
    url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|webp)$/) ||
    url.pathname.startsWith('/assets/')
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML navigation: network-first, fall back to cached '/' (SPA shell)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((cached) => cached || new Response('Offline', { status: 503 }))
      )
    );
    return;
  }
});

// ── Push notifications ─────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'WatchSync', message: 'Новое уведомление' };
  try {
    if (event.data) data = event.data.json();
  } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title || 'WatchSync', {
      body: data.message || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'watchsync-push',
      renotify: true,
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      const match = cs.find((c) => c.url.includes(self.location.origin));
      if (match) return match.focus();
      return clients.openWindow(targetUrl);
    })
  );
});

// ── Background Sync: offline chat queue ────────────────────────────────────
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('watchsync-offline', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending_chat')) {
        db.createObjectStore('pending_chat', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag !== 'chat-sync') return;
  event.waitUntil(
    openOfflineDB().then(async (db) => {
      const items = await new Promise((res, rej) => {
        const tx = db.transaction('pending_chat', 'readonly');
        const req = tx.objectStore('pending_chat').getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      for (const item of items) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (item.token) headers['Authorization'] = `Bearer ${item.token}`;
          const res = await fetch(`/api/v1/rooms/${item.roomId}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: item.content, username: item.username }),
          });
          if (res.ok || res.status === 400 || res.status === 401 || res.status === 403) {
            await new Promise((res2, rej2) => {
              const tx = db.transaction('pending_chat', 'readwrite');
              tx.objectStore('pending_chat').delete(item.id);
              tx.oncomplete = res2;
              tx.onerror = rej2;
            });
          }
        } catch {
          // Network still down — retry on next sync
        }
      }
    })
  );
});

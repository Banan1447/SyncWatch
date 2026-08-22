---
title: PWA / Service Worker
status: done
progress: 100
last_audited: 2026-08-07
tags: [frontend, pwa, service-worker, offline, install-prompt]
---

# PWA / Service Worker

## Описание
WatchSync — Progressive Web App. Поддерживает оффлайн-режим (SPA shell), кэширование статики, установку как PWA (Add to Home Screen) через браузер.

## Реализовано

- [x] `frontend/public/manifest.webmanifest` — имя "WatchSync", short_name, theme #7c6ff7, bg #09090f, display standalone, shortcuts на главную страницу
- [x] `frontend/public/sw.js` — Service Worker:
  - Precache: `/`, `/manifest.webmanifest`, `/icons/icon.svg` при install
  - Cache-first: JS/CSS/images/fonts (assets)
  - Network-first с SPA-fallback: HTML-навигация (работает offline)
  - Bypass: `/api/*`, `/ws*`, cross-origin, non-GET
  - Автоматический skipWaiting + clients.claim
  - Очистка старых кэшей при activate
- [x] `frontend/public/icons/icon.svg` — SVG иконка (play triangle + sync arc, purple/pink)
- [x] `frontend/index.html` — `<link rel="manifest">`, `theme-color`, `apple-touch-icon`, `apple-mobile-web-app-*` мета-теги, lang="ru"
- [x] `frontend/src/main.jsx` — регистрация SW при `window load`
- [x] `frontend/src/App.jsx` — `<InstallPrompt>` компонент:
  - Слушает `beforeinstallprompt`, показывает баннер снизу экрана
  - Кнопка "Установить" → `deferredPrompt.prompt()`
  - Кнопка "×" → dismiss на сессию (`sessionStorage`)

## Не реализовано

- [x] PNG иконки 192×192 и 512×512 — `frontend/scripts/generate-icons.js` (pure Node.js, CRC32 + zlib, без зависимостей). Manifest обновлён, SW precache → `watchsync-v2`.
- [x] Push-уведомления: VAPID ключи генерируются на старте auth-service и хранятся в Redis. `GET /api/v1/push/vapid-key`, `POST /api/v1/push/subscribe` (JWT required), `DELETE /api/v1/push/subscribe`. `POST /api/v1/auth/admin/broadcast` → push всем подписчикам (410/404 ответы автоматически удаляют устаревшие подписки). SW: `push` event → `showNotification`, `notificationclick` → фокус вкладки или `openWindow`. Форма broadcast в Admin.jsx (Dashboard). AuthContext: `subscribePush()` вызывается после login.
- [x] **Background Sync для отправки чата оффлайн**: IndexedDB `watchsync-offline` / objectStore `pending_chat` хранит `{ roomId, content, username, token, timestamp }`. При отключённом WS `sendChat` пишет в IndexedDB + `reg.sync.register('chat-sync')` + показывает сообщение с пометкой ⏳. SW `sync` handler постит в `POST /api/v1/rooms/{roomId}/messages` и удаляет из очереди. Неудачные попытки (сеть) оставляются для retry.

## Связанные файлы

- `frontend/public/manifest.webmanifest`
- `frontend/public/sw.js`
- `frontend/public/icons/icon.svg`
- `frontend/index.html`
- `frontend/src/main.jsx`
- `frontend/src/App.jsx`

---
title: React Frontend
status: in_progress
progress: 88
last_audited: 2026-08-07
tags: [frontend, react, vite, tailwind, typescript, websocket]
---

# React Frontend

## Описание
SPA на React 18 + Vite + TailwindCSS. Четыре основных страницы: выбор комнаты (с auth), плеер, админ-панель, файловый менеджер. WebSocket с автопереподключением, JWT auth, guest mode.

**Dev порт:** 8080 (HTTP), 8443 (HTTPS)  
**Build:** Vite 5, static files через NGINX

## TODO

### 🗂 Рефакторинг правого сайдбара — компактность и юзабилити ✅

**Выполнено** (2026-04-28):

#### Навигация по вкладкам
- [x] **Иконки + текст в табах** — `▶ Видео`, `≡ Очередь`, `💬 Чат`, `🎙 Голос`
- [x] **Бейдж непрочитанных сообщений** — `top:'-2px', right:'-2px'` (не перекрывается)
- [x] **Память последней вкладки** — `localStorage.sw_tab`

#### Вкладка «Видео»
- [x] **Аккордеон-секции** — Добавить видео / Текущее видео / Трансляция / Настройки синхронизации / Зрители. Состояние в `localStorage.sw_sections`
- [x] **Компактный блок «Добавить видео»** — URL-инпут + 📎 + кнопка «+» в одну строку
- [x] **Блок «Текущее видео»** — только если `currentVideo` есть (условный рендер)

#### Общий сайдбар
- [x] **Ширина сайдбара — resizable** — drag-handle 4px слева, диапазон 240–480px, `localStorage.sw_sidebar_w`

---

### 📱 Мобильная версия — качественный редизайн ✅

**Выполнено** (2026-04-28):

#### Навигация
- [x] **Bottom navigation bar** — фиксированная панель 56px внизу, 4 иконки с тогглом bottom sheet
- [x] **Bottom sheet для вкладок** — 60vh, drag indicator, tab header, `renderTabContent()` (общий с desktop)
- [x] **renderTabContent()** — общая функция для desktop sidebar и mobile bottom sheet (устраняет дублирование)

#### Плеер на мобильных
- [x] **Touch-friendly controls** — play/pause, mute, fullscreen: `minWidth: 44, minHeight: 44`
- [x] **Double-tap to seek** — двойной тап ±10 сек, анимация ◀◀ / ▶▶, 300ms threshold, 80px x-tolerance
- [x] **Swipe-down fullscreen exit** — delta > 80px → `exitFullscreen()`
- [x] **Горизонтальный режим (landscape)** — `screen.orientation change` → `requestFullscreen()`
- [x] **Прогресс-бар** — `height: 20px` для touch-friendly scrubbing

#### Header на мобильных
- [x] **Компактный мобильный header** — только logo/room/dot/members + `⋮` overflow menu (копировать ссылку, тема, выйти)

#### Производительность на мобильных
- [x] **Отключить ParticlesBackground на мобильных** — `{!isMobile && <ParticlesBackground />}` в App.jsx

#### Осталось (TODO)
- [ ] **Pull-to-refresh для очереди** — в mobile bottom sheet вкладки «Очередь»: pull-down → обновить очередь из API (причина: не реализовано в рамках текущего рефакторинга)
- [ ] **Lazy-load вкладок** — React.lazy/Suspense для неактивных вкладок (причина: требует отдельного рефакторинга Player.jsx)

---

- [x] **Autoplay interaction overlay** — браузер блокирует `video.play()` без пользовательского жеста (NotAllowedError). Добавлен `needsInteraction` state в Player.jsx: при получении `NotAllowedError` из `video.play()` (через `onAutoplayBlocked` prop в VideoPlayer) показывается full-screen overlay «Нажмите чтобы включить звук» с `zIndex:10000`. Клик по overlay: `setNeedsInteraction(false)` + `setStreamMuted(false)` + resume всех `<video>/<audio>` на странице. Также вызывается при `NotAllowedError` на стрим-видео. (`frontend/src/pages/Player.jsx`, `frontend/src/components/VideoPlayer.jsx` — prop `onAutoplayBlocked`)

- [x] **nginx resolver + lazy upstream resolution** — nginx падал при старте если любой upstream-сервис не запущен (`host not found in upstream`). Исправлено: добавлен `resolver 127.0.0.11 valid=10s ipv6=off` (Docker embedded DNS) + все `proxy_pass` переведены на переменные (`set $u http://...`). Nginx теперь резолвит хосты лениво при первом запросе, а не при старте — контейнер запускается независимо от состояния других сервисов. (`frontend/nginx.conf`)

- [x] **Трансляция плеера (captureStream)** — новый режим трансляции «▶ Плеер» в voice-вкладке: захватывает поток из `<video>` элемента через `videoRef.current.captureStream()` и транслирует его другим участникам через тот же WebRTC P2P пайплайн что и screen share. Не требует захвата экрана, нет лишней нагрузки. Кнопка `disabled` для YouTube/embed/kodik (captureStream недоступен из cross-origin iframe). `stream_type: 'player'` в `stream_start`. VideoPlayer.jsx: новый prop `captureStreamRef` — устанавливается в useEffect, возвращает `videoRef.current?.captureStream()`. (`frontend/src/pages/Player.jsx`, `frontend/src/components/VideoPlayer.jsx`)

- [x] **Пробел залипает / скроллит страницу** — при нажатии Space браузер иногда скроллит страницу вместо play/pause, или срабатывает двойной toggle (браузерный дефолт + наш handler). Причина: фокус попадает на кнопку/input → Space активирует элемент, а не плеер. Нужно: в keydown-хендлере `VideoPlayer.jsx` добавить `e.preventDefault()` для Space безусловно (сейчас уже есть, но только внутри `case ' '`) — проверить что `e.preventDefault()` вызывается до любой логики и не зависит от `e.target`. Дополнительно: при клике на плеер принудительно делать `containerRef.current.focus()` чтобы фокус не уходил на кнопки внутри controls. (`frontend/src/components/VideoPlayer.jsx`)

- [x] **Выпадающие меню качества в VideoPlayer.jsx — сделать тёмный фон** — HLS quality selector и MP4 quality selector имеют белый фон (`background: '#fff'`, `color: '#111'`), но должны быть в тёмном стиле как и весь плеер. Нужно: заменить на `background: 'rgba(15,15,25,0.92)'`, `color: '#e2e8f0'`, `border: '1px solid rgba(255,255,255,0.15)'`. Затронутые элементы: оба `<select>` в controls overlay (`frontend/src/components/VideoPlayer.jsx`, строки ~699 и ~732).

- [x] **Мобильная версия Player.jsx — полный редизайн** (2026-04-28): Bottom navigation bar (56px фикс), bottom sheet (60vh), compact header с ⋮ overflow, скрытие desktop-only кнопок на мобильных. Убран старый FAB. `renderTabContent()` — общий рендер вкладок для desktop sidebar и mobile sheet.
- [x] **Сайдбар — resizable + аккордеоны + иконки в табах** (2026-04-28): drag-handle 4px, 240–480px, `localStorage.sw_sidebar_w`; аккордеон-секции с `localStorage.sw_sections`; иконки+текст в табах; badge `top:-2px right:-2px`; компактный URL-инпут + 📎 + «+» в одну строку.
- [x] **VideoPlayer.jsx — mobile UX** (2026-04-28): double-tap seek ±10s с анимацией ◀◀/▶▶; swipe-down > 80px → exitFullscreen; auto-fullscreen on landscape; touch-friendly controls 44×44px; progress bar height 20px.
- [x] **ParticlesBackground отключён на мобильных** (2026-04-28): `{!isMobile && <ParticlesBackground />}` в App.jsx.
- [x] **Мобильная версия Player.jsx — кнопка скрытия/открытия правого сайдбара** — реализовано ранее (заменено на bottom nav в новом рефакторинге).

## Реализовано

### Страницы
- [x] **RoomSelect.jsx** — список комнат, создание, join по паролю, login/register модали, guest mode (~21KB)
- [x] **Player.jsx** — полный рефакторинг UX (co-watching платформа): компактный 44px header, cinema-режим без паддингов, коллапсируемый правый сайдбар (toggle ⇥/⇤), полоска участников с аватарами + speaking indicators под видео, chat overlay при свёрнутом сайдбаре (последние 15 сообщений + инпут поверх видео), stream controls перемещены в sidebar → video tab. Все функции сохранены: очередь, чат, голос, загрузка файлов.
- [x] **Admin.jsx** — дашборд метрик, комнаты, пользователи (CRUD + сброс пароля + бан), Docker контейнеры (status/restart/logs), вкладка Логи с поиском и кнопкой «Все логи», ссылки на Grafana/Prometheus/Jaeger/MinIO. Ссылка на FileManager в шапке табов.
- [x] **FileManager.jsx** — файловый менеджер MinIO: навигация по папкам (breadcrumbs), загрузка с прогресс-баром + DnD, создание/удаление папок, переименование, перемещение, мультиселект, добавление в очередь комнаты. Маршрут `/files?room=<roomId>`. Синхронизация через polling 5s.

### Компоненты и хуки
- [x] **VideoPlayer.jsx** — мультисорсный плеер (~27KB). Пропы: `onAutoplayBlocked` (callback при NotAllowedError), `captureStreamRef` (ref для captureStream API), `onPlayStateChange`, `onSyncReady`, `onTimeUpdate`
- [x] **ParticlesBackground.jsx** — анимированный фон (canvas particles + cursor glow)
- [x] **AuthContext.jsx** — login/register/logout/loginAsGuest/refreshToken, localStorage persistence
- [x] **useWebSocket.js** — WebSocket с exponential backoff reconnect, event emitter pattern
- [x] **useVoiceChat.js** — WebRTC голосовой чат (~19KB)

### Технологии
- [x] React 18.3.1 + React Router 6.22.3
- [x] TailwindCSS 3.4.3
- [x] HLS.js 1.5.7
- [x] Vite 5.2.0
- [x] JWT auth (localStorage, автообновление)
- [x] Guest mode (локальный токен без регистрации)

## Не реализовано

- [x] PWA / Service Worker — [FEATURE_pwa](./FEATURE_pwa.md) (manifest, SW, install prompt)
- [x] Тёмная/светлая тема — ThemeContext + CSS variables + переключатель в RoomSelect и Player
- [x] i18n / мультиязычность — react-i18next, переводы ru/en в `src/locales/{ru,en}/{common,rooms,auth,player}.json`. Покрытие: вкладки плеера, кнопки голосового чата (join/leave/mute/deafen), устройства, уровень микрофона, обработка звука, очередь, чат (placeholder/send), статус участников. Переключатель EN/RU в RoomSelect и Player.
- [ ] **Темы оформления (несколько тем)** — сделать когда будет личный кабинет пользователя. Минимум: светлая, AMOLED, кастомная (через CSS-переменные). Выбор темы сохранять в профиле пользователя (не только localStorage). ThemeContext уже есть — расширить. (причина отсрочки: тема должна синхронизироваться с профилем, а не быть локальной настройкой)

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — AuthContext: login/register/guest, JWT в localStorage
- [FEATURE_rooms](./FEATURE_rooms.md) — RoomSelect.jsx: список, создание, вход в комнату
- [FEATURE_sync](./FEATURE_sync.md) — VideoPlayer.jsx обрабатывает sync события (soft/hard sync)
- [FEATURE_video_queue](./FEATURE_video_queue.md) — VideoPlayer.jsx + очередь в Player.jsx
- [FEATURE_chat](./FEATURE_chat.md) — вкладка Чат в Player.jsx
- [FEATURE_voice_rtc](./FEATURE_voice_rtc.md) — useVoiceChat hook, вкладка Voice
- [FEATURE_admin](./FEATURE_admin.md) — Admin.jsx страница
- [FEATURE_file_manager](./FEATURE_file_manager.md) — FileManager.jsx страница
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — NGINX раздаёт сборку фронтенда
- [FEATURE_transcoder](./FEATURE_transcoder.md) — кнопки Remux/Fix-Audio в Player.jsx инициируют транскодирование
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — useWebSocket.js: подключение к WS Gateway с exponential backoff reconnect
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — VideoPlayer.jsx должен переключаться на proxy URL при proxy_mode_enabled
- [FEATURE_monitoring](./FEATURE_monitoring.md) — Admin.jsx содержит ссылки на Grafana (3001), Prometheus (9090), Jaeger (16686)

## Связанные файлы

- `frontend/src/pages/` — страницы
- `frontend/src/components/` — компоненты
- `frontend/src/hooks/` — useWebSocket.js, useVoiceChat.js
- `frontend/src/contexts/AuthContext.jsx`
- `frontend/vite.config.js`
- `frontend/tailwind.config.js`
- `frontend/package.json`
- `config/nginx/nginx.conf` — раздача сборки

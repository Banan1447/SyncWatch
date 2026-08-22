---
title: Stream Cacher
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, video-service, yt-dlp, ffmpeg, minio, frontend, react]
---

# Stream Cacher

## Описание
Функция перехвата и кэширования любого видеопотока на сервере. Позволяет записать поток в MinIO в фоновом режиме и воспроизводить его как обычный файл — с поддержкой синхронного просмотра всеми участниками комнаты.

## Реализовано

### Бэкенд (Video Service)
- [x] `POST /api/v1/cache` — начать кэширование URL. Дедупликация: если уже кешируется — возвращает существующий job
- [x] `GET /api/v1/cache` — список всех jobs (id, url, title, status, progress, cached_url, error)
- [x] `DELETE /api/v1/cache?id=...` — удалить job + файл из MinIO
- [x] Фоновая горутина: yt-dlp → fallback ffmpeg → upload to MinIO `cache/{id}/video.{ext}`
- [x] Статусы job: `pending` → `downloading` → `done` | `error`
- [x] SponsorBlock (`--sponsorblock-remove all`) для YouTube через yt-dlp
- [x] In-memory хранение jobs (`sync.Map`), выживает пока контейнер жив
- [x] Кеш хранится в MinIO `cache/{id}/video.{ext}`, стримится через `/api/v1/videos/stream/cache/{id}/video.{ext}`
- [x] Dockerfile: добавлены `ffmpeg`, `python3`, статический бинарь `yt-dlp_linux`
- [x] Kong route `stream-cache-routes` — JWT-protected

### Фронтенд (Player.jsx — вкладка Очередь)
- [x] Polling `/api/v1/cache` каждые 3 секунды
- [x] Кнопка 💾 у каждого item в очереди → запустить кэширование
- [x] Во время загрузки: показывает прогресс в % вместо кнопки
- [x] Когда готово: кнопка ✓ (воспроизвести из кеша) + 🗑 (удалить из кеша)
- [x] При ошибке: кнопка ⚠ (повторить)
- [x] Воспроизведение из кеша: `jumpToVideo({ ...item, video_url: cached_url, src: cached_url })`

## Не реализовано

- [x] Персистентность jobs в Redis — `cache:job:{id}` + `cache:jobs` set, TTL 7 дней, при рестарте in-flight jobs сбрасываются в `error`
- [x] Прогресс ffmpeg fallback — `-progress pipe:1` + парсинг `out_time_us`, 0–90% во время загрузки
- [x] Удаление рекламы из YouTube — `--sponsorblock-remove all` передаётся в yt-dlp при кэшировании. Автоматически вырезает sponsors/intros/outros/intermission/self_promo/preview/filler. Работает только для YouTube (SponsorBlock API). Для произвольных HLS/MP4 потоков ad-removal не реализован — требует ML-детекцию, out of scope.
- [x] Лимит параллельных jobs (сейчас без ограничений)
- [x] UI страница управления кешем (отдельная страница /cache)
- [x] Автозамена URL после кэширования — `useEffect` в Player.jsx отслеживает переход `status → done` в `cacheJobs`. Если хост сейчас смотрит то видео которое только что закэшировалось, автоматически переключает всех на `cached_url` через `sendMessage({type:'video_select',...})`. Toast-уведомление «✓ Видео закэшировано — переключено на локальную версию». `autoSwitchCacheRef` предотвращает повторные переключения. (`frontend/src/pages/Player.jsx`)

## TODO

- [x] **GET /api/v1/cache возвращает 401 у незалогиненных / гостей** — `Player-*.js: GET /api/v1/cache 401 (Unauthorized)`. Kong route `stream-cache-routes` требует JWT, но guest-режим не имеет токена. Нужно: либо разрешить GET `/api/v1/cache` без JWT (только чтение, не создание), либо в `Player.jsx` не запускать polling если `!token`. (`config/kong/kong.yml`, `frontend/src/pages/Player.jsx` — `refreshCacheJobs` useEffect/interval)

- [x] Лимит параллельных jobs — `cacheJobSemaphore = make(chan struct{}, 3)` — buffered channel из 3 слотов. `runCacheJob` захватывает слот при старте и освобождает по `defer`. Лишние jobs блокируются в goroutine пока слот не освободится. (`services/video/main.go`)

## Связанные файлы

- `services/video/main.go` — `handleStartCache`, `handleListCache`, `handleDeleteCache`, `runCacheJob`, `runYtDlp`, `runFfmpegDownload`
- `services/video/Dockerfile` — ffmpeg + yt-dlp_linux
- `config/kong/kong.yml` — route `stream-cache-routes`
- `frontend/src/pages/Player.jsx` — `cacheJobs` state, `refreshCacheJobs`, `startCaching`, `deleteCacheJob`, `getCacheJobForItem`; кнопка «💾 Кеш» открывает `/cache?room=...`
- `frontend/src/pages/CacheManager.jsx` — страница управления кешем (`/cache`): список jobs, добавление URL, прогресс, удаление, воспроизведение
- `frontend/src/App.jsx` — маршрут `/cache`

## Связанные фичи

- [FEATURE_infra](./FEATURE_infra.md) — MinIO bucket `videos` хранит кеш под префиксом `cache/`
- [FEATURE_video_queue](./FEATURE_video_queue.md) — кнопки кеша встроены в queue items
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong route для `/api/v1/cache`

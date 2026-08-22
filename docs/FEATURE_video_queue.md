---
title: Video Queue & Multi-Source Player
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, frontend, react, video, queue, youtube, hls, postgresql]
---

# Video Queue & Multi-Source Player

## Описание
Управление очередью видео в комнате (Go-сервис) + многоисточниковый плеер на клиенте (React + VideoPlayer.jsx). Поддерживает YouTube, HLS, прямые ссылки, embed-плееры и server proxy mode.

**Порт:** 8084 (Video Service)

## TODO

### Локальные файлы (критично)

- [x] **[BUG] После загрузки файла хост видит чёрный экран** — исправлено: в `handleUpload` перед `revokeObjectURL` вызывается `setCurrentVideo(remoteVideo)` с удалённым URL. (`frontend/src/pages/Player.jsx`)

- [x] **[BUG] После загрузки другие участники не видят видео** — исправлено двумя способами: (A) `handleUpload` после загрузки отправляет `video_select` WS-событие; (B) `broadcastQueueUpdate` включает `current: items[0]` если очередь непуста, `handleGetQueue` возвращает `{items, current}`. (`frontend/src/pages/Player.jsx`, `services/video/main.go`)

- [x] **[BUG] `GET /rooms/{id}/queue` возвращает голый массив вместо `{items, current}`** — исправлено: `handleGetQueue` теперь возвращает `{items: [...], current: items[0] or null}`. (`services/video/main.go`)

- [ ] **[BUG] "Смотреть только локально" — другие участники ничего не видят** — при нажатии кнопки blob-URL устанавливается только у хоста, никакого события не отправляется. Другие участники не знают что хост смотрит видео. **Фикс**: показывать overlay/тост остальным «Хост просматривает локально, загрузка не начата». (`frontend/src/pages/Player.jsx`)

- [x] **[UX] Нет уведомления участникам о процессе загрузки** — исправлено: `handleUpload` отправляет `video_action: {action:'uploading', title, progress}` по WS; в Player.jsx добавлен overlay `hostUploadNotif` с прогресс-баром для всех не-загружающих участников. Очищается по `video_select`, `video_updated`, `upload_cancelled`. (`frontend/src/pages/Player.jsx`)

- [x] **[UX] Нет drag-and-drop для загрузки файлов** — исправлено: добавлены `onDragOver`/`onDragLeave`/`onDrop` на upload-контейнер. (`frontend/src/pages/Player.jsx`)

- [x] **[UX] Нет кнопки отмены загрузки** — исправлено: добавлена кнопка «✕» рядом с прогресс-баром во время загрузки, вызывает `cancelUpload()`. (`frontend/src/pages/Player.jsx`)

- [x] **[UX] Нет error-toast при ошибке загрузки** — исправлено: `xhr.onerror` показывает `setTranscodeToast({msg: 'Ошибка загрузки файла...', type: 'error'})`. (`frontend/src/pages/Player.jsx`)

- [x] **Очередь не обновляется на лету при добавлении видео другим пользователем** — исправлено. Корень: video-service публикует `queue_update` в NATS subject `room.{id}.broadcast` без `room_id` в payload, а ws-gateway делал `Unmarshal` без извлечения roomID из subject → `s.rooms[""]` пустой → broadcast терялся. Фикс в [ws-gateway/main.go:215-228](services/ws-gateway/main.go#L215-L228) — извлекаем roomID из subject (`strings.Split(subject, ".")[1]`) если отсутствует в payload. Бенефит: фикс работает для всех NATS-подписчиков (chat, sync, queue, transcode events)
- [x] **При переключении видео из очереди громкость становится максимальной** — исправлено. В VideoPlayer.jsx добавлены `volumeRef` + `mutedRef`, восстановление `video.volume`/`video.muted` в `handleCanPlay` (HTML5/HLS) и `e.target.setVolume() + mute/unMute()` в YT `onReady`. Бонус: persist в `localStorage.sw_volume` / `sw_muted` — сохраняется между сессиями ([VideoPlayer.jsx:66-75, 119-126, 178-184](frontend/src/components/VideoPlayer.jsx#L66))

- [x] **Выбор качества для HLS потоков** — в VideoPlayer.jsx добавлен `<select>` дропдаун качества для `srcType === 'hls'` с multiple levels. `hls.on(Hls.Events.MANIFEST_PARSED)` заполняет `hlsLevels` ({index, height, bitrate}). `useEffect` на `hlsLevel` применяет `hls.currentLevel = N` (-1 = авто). Дропдаун появляется только если levels > 1. (`frontend/src/components/VideoPlayer.jsx`)
- [x] **Выбор качества для локальных MP4-файлов** — реализован `GET /api/v1/videos/qualities?key=...` (video service). Проверяет MinIO на наличие `hls/{key}/master.m3u8` (HLS Adaptive) и `videos/{key}/output.mp4` (MP4 transcoded). В VideoPlayer.jsx: кнопка «HD?» появляется для MinIO-файлов (`/api/v1/videos/stream/...`) при `srcType=direct`. При нажатии загружает варианты; если есть — показывает `<select>` с переключением src + restore currentTime + playback state. Kong route: `video-qualities` (GET). (`services/video/main.go`, `frontend/src/components/VideoPlayer.jsx`, `config/kong/kong.yml`) Реализация (выполнено):
  1. **Backend**: при загрузке файла или по on-demand генерировать варианты разрешений через transcoder (HLS adaptive `master.m3u8` с уровнями 360p/480p/720p/1080p), сохранять в MinIO `videos/{key}/transcoded/{quality}.mp4` + `videos/{key}/master.m3u8`
  2. **API**: `GET /api/v1/videos/{key}/qualities` → `[{label:'1080p', url:'/api/v1/videos/stream/...', bitrate}, ...]` + `master_url` для HLS adaptive
  3. **Frontend**: в `VideoPlayer.jsx` парсить `currentVideo.qualities`, если есть — рендерить дропдаун рядом со speed-presets (0.5×/1×/1.5×/2×). При выборе качества: для HLS — `hls.currentLevel = N`; для отдельных файлов — `video.src = newUrl` + восстановление `currentTime` и `playbackRate`
  4. **Fallback**: если transcoded-варианты ещё не готовы, показывать «Качество: обработка...» + автоматическая постановка в очередь на transcoding
  5. **Persist выбора**: `localStorage.setItem('sw_preferred_quality', '720p')` — применять как дефолт при следующих видео
  6. **Per-room sync (опционально)**: WS-событие `quality_change` чтобы хост мог принудительно переключить всех на одно качество (для слабых интернетов кого-то из участников)

## Реализовано

### Backend (Video Service)
- [x] Очередь видео на комнату (`GET/POST /rooms/{id}/queue`)
- [x] Позиционирование в очереди, смена порядка
- [x] Max queue: 100 видео
- [x] PostgreSQL — таблица `video_queue` (статусы: pending/playing/done/failed)
- [x] FlareSolverr интеграция для Cloudflare-защищённых сайтов (http://flaresolverr:8191)
- [x] YouTube Data API поиск и метаданные
- [x] MinIO для загрузки видео-файлов
- [x] Server Proxy Mode эндпоинты: `GET /api/v1/rooms/{id}/proxy-url`, `POST /api/v1/rooms/{id}/proxy-config`
- [x] `PATCH /rooms/{id}/queue/reorder` — атомарный реордер позиций через PostgreSQL транзакцию
- [x] Redis кэш метаданных видео (DB 0)
- [x] WS события: `video_action`, `video_select`, `video_updated`
- [x] NATS broadcast `queue_update` после add/delete/reorder → все клиенты комнаты синхронизируют очередь в реальном времени

### Frontend (VideoPlayer.jsx)
- [x] YouTube IFrame API (play/pause/seek/rate)
- [x] HLS потоки (hls.js 1.5.7)
- [x] Direct MP4/WebM (HTML5 video)
- [x] Embed (Kodik, Alloha, Moonwalk, Turbo и др.)
- [x] Embed с экстракцией (animego, anilibria, etc.)
- [x] Per-tab session ID — echo guard для избежания самофильтрации
- [x] Sync пороги: soft=0.5s, hard=4s
- [x] Управление состоянием: `video_action` (play/pause/seek/rate/volume/mute)
- [x] Fullscreen, PiP
- [x] Отображение заголовка, источника

- [x] **Thumbnail в очереди**: поле `thumbnail_url` в `QueueItem` + `video_metadata`. Для YouTube вычисляется автоматически (`img.youtube.com/vi/{id}/mqdefault.jpg`). Для embed-сайтов — `og:image` из страницы (возвращается через `embed/extract`). Фронтенд отображает 44×25px превью (с fallback иконкой ▶). `getItemThumbnail()` поддерживает: прямой `thumbnail_url`, `video_metadata.thumbnail_url`, деривацию из YouTube URL.

## Не реализовано
- [x] Поиск/фильтр внутри очереди (client-side, инпут появляется при queue.length > 0, фильтрует по title/URL)
- [x] Drag-and-drop переупорядочивание очереди во фронтенде (HTML5 DnD, PATCH API, оптимистичное обновление)
- [x] **Прогресс-бар загрузки файла в очереди**: при загрузке локального файла в очереди появляется псевдо-элемент с именем файла, фиолетовым прогресс-баром и процентом «Загрузка X%». Исчезает после завершения, заменяется реальным элементом очереди.
- [x] **Исправлена загрузка файлов**: `handleUpload` принимает поле `"file"` (стандарт) и `"video"` (fallback). URL возвращается как `/api/v1/videos/stream/{key}` — доступен из браузера через nginx, а не внутренний MinIO hostname.

## Связанные фичи

- [FEATURE_rooms](./FEATURE_rooms.md) — очередь принадлежит комнате
- [FEATURE_sync](./FEATURE_sync.md) — Sync Engine управляет переключением видео из очереди
- [FEATURE_transcoder](./FEATURE_transcoder.md) — видео из очереди отправляется на транскодирование
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — proxy URL генерируется для видео из очереди
- [FEATURE_frontend](./FEATURE_frontend.md) — VideoPlayer.jsx воспроизводит, Player.jsx управляет очередью
- [FEATURE_infra](./FEATURE_infra.md) — PostgreSQL (video_queue), MinIO (файлы), Redis кэш
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong routing `/api/v1/rooms/{id}/queue/*`
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — WS-события video_action, video_select, video_updated
- [FEATURE_monitoring](./FEATURE_monitoring.md) — video_service_* метрики в Prometheus

## Связанные файлы

- `services/video/main.go` (~663 строк)
- `services/video/Dockerfile`
- `init/postgres/03_video_queue.sql`
- `frontend/src/components/VideoPlayer.jsx` (~27KB)
- `frontend/src/pages/Player.jsx` — управление очередью в UI

---
title: Video Transcoder
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, ffmpeg, transcoder, minio, nats, redis]
---

# Video Transcoder

## Описание
Go-сервис фоновой обработки видео. Принимает задания через NATS/Redis, транскодирует через FFmpeg, сохраняет результат в MinIO. Работает без HTTP-порта — только через очередь.

## TODO
- [ ] Сделать отдельную страницу для отслеживания и удобного управления транскодером и видео которые были или не были транскодированы(написанно человеком , при первом чтении актуализировать под наш проект)

- [x] **FFmpeg не может открыть YouTube URL напрямую — exit 183** — при отправке `https://www.youtube.com/watch?v=...` в transcoder ffmpeg падает с `Invalid data found when processing input` (exit status 183). YouTube URL нельзя открыть напрямую через ffmpeg — нужно: (a) на стороне сервиса детектировать YouTube URL (`youtu.be|youtube.com`) до запуска ffmpeg, (b) сначала скачать видео через `yt-dlp -o -` или сохранить во временный файл, затем передать ffmpeg этот файл, (c) либо отклонять задачу с понятной ошибкой `"YouTube URL не поддерживается — сначала скачайте видео"` и показывать это в UI. (`services/transcoder/main.go` — `processJob`, UI Player.jsx — toast с инструкцией)

- [x] **ffmpeg 360p failed: exit status 254** — при транскодировании в 360p ffmpeg падает с неспецифичной ошибкой exit 254. Возможные причины: (a) входной файл повреждён или имеет нестандартный контейнер, (b) разрешение 640x360 конфликтует с кодеком (libx264 требует чётные размеры — проверить что `scale=640:360` не даёт нечётный результат), (c) нет свободного места во временной директории, (d) NVENC quota. Нужно: добавить полный вывод stderr в поле `error` job'а (сейчас пишется только первая строка), добавить `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2` или явно `scale=640:360:force_original_aspect_ratio=decrease,pad=640:360` для безопасного даунскейла. (`services/transcoder/main.go` — `processJob` 360p variant)

- [ ] **Идея: LLM-озвучка YouTube через субтитры** *(не запланировано — требует отдельного `services/dubbing/` сервиса)* — отдельный пайплайн для перевода видео с YouTube на другой язык. Шаги: (1) скачать субтитры (yt-dlp `--write-auto-sub --sub-format vtt` либо через существующий `extract-subtitles`), (2) прогнать через LLM для перевода (LM Studio / OpenAI-совместимый endpoint — см. [FEATURE_mcp](./FEATURE_mcp.md)), (3) синтезировать речь по таймкодам (TTS — Silero / ElevenLabs / Coqui), (4) микс-дорожку с оригинальным видео через ffmpeg `-map 0:v -map 1:a -c:v copy -c:a aac`, (5) кэшировать результат в MinIO bucket `videos/dubs/{videoId}/{lang}.mp4` + метаданные в Redis.

### Best practices из легаси (`<legacy-project-path>`)

- [x] **NVENC hardware acceleration с CPU-fallback** — `detectNVENC()` при старте запускает `ffmpeg -encoders` и проверяет наличие `h264_nvenc`. Результат сохраняется в `nvencAvailable`. `videoEncoder()` возвращает `"h264_nvenc"` или `"libx264"`, `encoderPreset()` — `"llhq"` или `"fast"`. Обе функции используются в `processJob` и `processMP4Job`. (`services/transcoder/main.go`)
- [x] **Cancellation flag + soft kill ffmpeg-процесса** — реализовано. `POST /api/v1/transcode/{jobId}/cancel`: если job активно обрабатывается — вызывает cancel-функцию из `sync.Map cancelFuncs`, ffmpeg получает SIGKILL через `exec.CommandContext`. Если job ещё в очереди — помечается `cancelled` в Redis. Поле `Cancelled bool` + `status:"cancelled"` в `TranscodeJob`. Kong route `transcode-cancel` (regex, regex_priority:10, JWT). (`services/transcoder/main.go`, `config/kong/kong.yml`)
- [x] **«Quality/Speed» slider с автомаппингом 0-100 → template** — реализован в Video-вкладке Player.jsx для локальных файлов MinIO (`/api/v1/videos/stream/`). Слайдер 0→100 (0=лучшее, 100=быстрее): 0-33 → `hls_adaptive`, 34-66 → `mp4_1080p`, 67-100 → `mp4_720p`. Показывает label шаблона и оценку времени (~4/8/15 мин/ГБ). `POST /api/v1/transcode` с `room_id` для WS-уведомления. Результат отображается через `transcodeToast`. (`frontend/src/pages/Player.jsx`)
- [x] **Estimated time calculation** перед запуском задания — показывается в UI до клика «Транскодировать» (~4/8/15 мин/ГБ в зависимости от выбранного пресета) (формула `1 + ((100 - sliderValue) * 0.09)` мин/ГБ). Управляет ожиданиями пользователя. (Легаси: `transcode.html:619-627`)
- [x] **Default templates auto-seed + кастомные шаблоны** — добавлен `mp4_480p` в built-in список (теперь: hls_adaptive, hls_720p, mp4_480p, mp4_720p, mp4_1080p). `POST /api/v1/transcode/templates` создаёт кастомный шаблон (структурированные параметры: name, format=mp4, resolution, video_bitrate, crf, preset) — хранится в Redis `transcode:template:{id}` TTL 30 дней. `DELETE /api/v1/transcode/templates/{id}` удаляет. `GET /api/v1/transcode/templates` возвращает built-in + кастомные. `processJob` поддерживает кастомные шаблоны через Redis-lookup. Валидация: resolution и preset из enum-whitelist, crf 0-51 (защита от command injection). Kong routes: `transcode-templates` (GET+POST), `transcode-template-delete` (DELETE, regex_priority:15). (`services/transcoder/main.go`, `config/kong/kong.yml`)
- [x] **Quick-transcode one-click без выбора шаблона** — `POST /api/v1/transcode/quick` принимает `{video_id, input_url, room_id?}`, автоматически выбирает `mp4_1080p` при наличии NVENC, иначе `mp4_720p`. Kong route добавлен в `transcode-protected`. (`services/transcoder/main.go`)
- [x] **fail-soft `getVideoInfo`** — реализован в Video Service как `GET /api/v1/files/info?key=...`: запускает ffprobe через `exec.CommandContext` (15с таймаут), при любой ошибке возвращает поля со значением "N/A". Kong route `file-manager-info`. (`services/video/main.go`, `frontend/src/pages/FileManager.jsx`)
- [x] **Persistent очередь + RecoverStuckJobs** — `recoverStuckJobs()` при старте сканирует `transcode:job:*` ключи в Redis, находит задания со статусом `processing` (оставшиеся от предыдущего запуска), сбрасывает их в `queued` + добавляет обратно в `transcode:queue`. Вызывается в `Initialize()` перед стартом worker. (`services/transcoder/main.go`)

## Реализовано

- [x] Получение задач через NATS и Redis (DB 4) очередь
- [x] FFmpeg интеграция (бинарь в Docker образе)
- [x] Транскодирование в HLS (сегменты .ts + .m3u8 плейлист)
- [x] Транскодирование в MP4 (remux и ре-кодирование)
- [x] Загрузка результата в MinIO bucket `videos`
- [x] Статусы задач: `queued → processing → done / failed`
- [x] Temp директория: `/tmp/transcoder`
- [x] Prometheus метрики: `transcoder_jobs_processed_total`, `transcoder_jobs_failed_total`, `transcoder_active_jobs`
- [x] Remux без перекодирования (`-c copy -movflags +faststart`)
- [x] Fix-audio (`-c:v copy -c:a aac -b:a 192k`)
- [x] Progress tracking (0–100%) — парсинг `time=` из ffmpeg stderr, хранение в Redis job, NATS `transcode.progress` событие → ws-gateway → клиент в реальном времени
- [x] WS-уведомление о завершении — `transcode.completed` NATS → `room.{roomId}.broadcast` → frontend toast
- [x] `room_id` в TranscodeJob — маршрутизация событий в нужную комнату
- [x] Frontend toast в Player.jsx при `transcode_completed` (зелёный/красный, 6 сек)
- [x] `stream_url` в completion event — `/api/v1/videos/stream/hls/{videoID}/master.m3u8` (nginx → MinIO прямой путь)
- [x] Auto-HLS после загрузки файла — video-service публикует `transcode.request` в NATS после upload (с `room_id` из form), фронтенд хранит `video_id`, переключается на HLS при получении `transcode_completed` для этого `video_id`

## Не реализовано

- [x] HTTP API для отслеживания прогресса задачи (progress %) — хранится в Redis, доступен через `GET /api/v1/transcode/:jobId`
- [x] Шаблоны транскодирования через API: `GET /api/v1/transcode/templates` → список шаблонов (hls_adaptive, hls_720p, mp4_720p, mp4_1080p); `Template` поле в submit job, валидация
- [x] **Subtitle extraction**: `POST /api/v1/transcode/extract-subtitles` body: `{ input_url, stream_index?, format? }` (srt/vtt/ass). ffmpeg `0:s:{index}` demux → MinIO `subtitles/{id}.{ext}` → ответ `{ url, filename, format }`. Frontend: раздел «📝 Субтитры» в видео-вкладке Player.jsx с выбором дорожки и формата, кнопка скачивания результата. Kong route добавлен (JWT protected).

## Связанные фичи

- [FEATURE_video_queue](./FEATURE_video_queue.md) — Video Service создаёт задания транскодирования
- [FEATURE_infra](./FEATURE_infra.md) — MinIO (готовые файлы), Redis DB 4 (очередь), NATS (задания)
- [FEATURE_monitoring](./FEATURE_monitoring.md) — Prometheus: transcoder_jobs_processed_total, transcoder_active_jobs
- [FEATURE_frontend](./FEATURE_frontend.md) — кнопки Remux/Fix-Audio в Player.jsx инициируют транскодирование

## Связанные файлы

- `services/transcoder/main.go` (~469 строк)
- `services/transcoder/Dockerfile`
- `services/video/main.go` — создаёт задания транскодирования

---
title: Video Sync Engine
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, sync, crdt, redis, nats, realtime]
---

# Video Sync Engine

## Описание
CRDT-based сервис синхронизации видео между всеми участниками комнаты. Отслеживает состояние плеера (play/pause/seek/rate) с учётом сетевой задержки каждого клиента. Рассылает heartbeat каждые 50ms.

**Порт:** 8086 (внешний), 8080 (внутренний)

## Реализовано

- [x] CRDT last-write-wins по `version` (seek/rate); play/pause всегда применяются напрямую (обход CRDT — иначе "pause работает через раз")
- [x] Heartbeat рассылка — **4s при воспроизведении, 10s на паузе** (адаптивный ticker, не 50ms)
- [x] Heartbeat пропускается если event-driven broadcast был < 500ms назад (anti-stale race)
- [x] Per-room heartbeat goroutine: auto-stop через 30 мин простоя, `activeHeartbeats` метрика
- [x] `calculateAdjustedTimeFrom`: `currentTime + elapsed * rate + bufferOffset` для late-joiners
- [x] Buffer offset: 50ms, MaxDrift: 100ms — читается из env
- [x] Status probe — unicast ответ конкретному клиенту через NATS `room.{id}.user.{uid}`
- [x] Состояние хранится в Redis (DB 2), восстанавливается при рестарте
- [x] Получение событий через NATS: `room.*.video_action`, `room.*.ping`, `room.*.status_probe`
- [x] Двухфазный cleanup неактивных комнат (RLock для сбора, Lock для удаления)
- [x] Prometheus метрики: `sync_service_active_rooms`, `sync_service_operations_total`, `sync_service_active_heartbeats`
- [x] WS события: `state_sync`, `all_synced`, `sync_pending`
- [x] **Pause-on-join**: при подключении нового участника ws-gateway удаляет его из `readyUsers` и вызывает `broadcastSyncStatus` → `sync_pending` → VideoPlayer получает `syncBlocked=true` (Player.jsx) → видео паузируется локально у всех клиентов с overlay «{username} подключается... X/Y готовы» + progress bar. При `all_synced` — `syncBlocked=false`, видео возобновляется. (2026-04-27)

- [x] **Per-room sync settings**: владелец комнаты видит слайдеры «Мягкий порог» (0.1–2с) и «Жёсткий порог» (1–15с) во вкладке Видео. Кнопка «Применить для всех» → WS `sync_settings_update` → ws-gateway сохраняет в Redis + broadcast `sync_settings` → `VideoPlayer.jsx` использует пропы `softThreshold`/`hardThreshold` вместо констант. При подключении late-joiner получает настройки через `room_init`.

## TODO

- [x] **Continuous P-controller (Drift Sync)** — реализован 2026-04-27. Всегда включён для всех, без UI-переключателя. `setInterval(200ms)` в `VideoPlayer.jsx`, активен только когда `isPlaying && !syncBlocked`. Алгоритм: `projected = base + elapsed * rate`; `drift = currentTime - projected`; если `|drift| < 50ms (deadband)` → сброс rate; иначе `correction = clamp(drift * 0.5, -0.10, +0.10)`, `playbackRate = nominal - correction`. `projectedRef` обновляется на каждом `state_sync` хартбите. При паузе/syncBlocked — rate сбрасывается в nominal. Константы: `kP=0.5`, `deadband=0.05s`, `maxCorrection=±10%`. (`frontend/src/components/VideoPlayer.jsx`)

## Не реализовано

- [x] Настройка порогов drift/offset: env `BUFFER_OFFSET_MS` / `MAX_DRIFT_MS` + runtime API `GET/POST /config` → `{"buffer_offset_ms":N,"max_drift_ms":N}`. Thread-safe через `config.mu RWMutex`.

## Связанные фичи

- [FEATURE_rooms](./FEATURE_rooms.md) — каждая комната имеет свой sync engine
- [FEATURE_video_queue](./FEATURE_video_queue.md) — sync управляет текущим видео в очереди
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — `state_sync`, `sync_ready` рассылаются через WS
- [FEATURE_frontend](./FEATURE_frontend.md) — VideoPlayer.jsx обрабатывает sync события (soft/hard sync)
- [FEATURE_infra](./FEATURE_infra.md) — Redis DB 2 (состояние), NATS (события play/pause/seek)
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — Sync Service обновляет метаданные комнаты при включении proxy mode
- [FEATURE_monitoring](./FEATURE_monitoring.md) — метрики: sync_service_active_rooms, sync_service_operations_total

## Связанные файлы

- `services/sync/main.go` (~682 строк)
- `services/sync/Dockerfile`
- `services/ws-gateway/main.go` — трансляция `state_sync` событий
- `frontend/src/components/VideoPlayer.jsx` — клиентская сторона sync

---
title: WebSocket Gateway
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, websocket, gateway, redis, nats, realtime]
---

# WebSocket Gateway

## Описание
Центральный WebSocket-сервер (Go). Единственная точка входа для всей real-time коммуникации клиентов. Маршрутизирует сообщения между клиентами, сервисами (через NATS) и Redis. Поддерживает до 100,000 одновременных подключений.

**Порт:** 8085 (внешний), 8080 (внутренний), WS эндпоинт: `/ws`

## Реализовано

- [x] WebSocket сервер (gorilla/websocket)
- [x] Управление подключениями (join/leave/kick)
- [x] Ping/Pong keepalive — интервал 30s, timeout 10s
- [x] Redis pub/sub для масштабирования на несколько инстансов (DB 1)
- [x] NATS fan-out — трансляция событий в сервисы
- [x] Echo guard — per-tab `client_id` для фильтрации собственных сообщений

### Поддерживаемые типы сообщений (31):
- [x] `join_room`, `leave_room` — управление комнатой
- [x] `room_init` — Server→Client при join: полное начальное состояние (users, video_url, state, broadcaster)
- [x] `video_action`, `video_select`, `video_updated` — видео
- [x] `chat_message`, `reaction` — чат
- [x] `state_sync`, `sync_ready`, `all_synced`, `sync_pending` — синхронизация
- [x] `webrtc_offer`, `webrtc_answer`, `webrtc_ice` — WebRTC P2P видео/экран
- [x] `voice_join`, `voice_leave`, `voice_offer`, `voice_answer`, `voice_ice` — голос (те же relay что и webrtc, разные типы)
- [x] `stream_start`, `stream_stop` — начало/конец трансляции (хранит BroadcasterInfo, удаляет при дисконнекте)
- [x] `stream_active` — Server→Client при join если broadcast уже идёт
- [x] `stream_chunk` — relay MediaRecorder chunks (base64 webm); первый chunk (`init:true`) кэшируется для late-joiners
- [x] `user_joined`, `user_left` — события участников; `user_left` отправляется и при дисконнекте
- [x] `ping`, `pong` — клиентский keepalive (отдельно от WS Ping/Pong фреймов)
- [x] `status_probe` — Client→Sync Service через NATS; unicast ответ через `room.{id}.user.{uid}`
- [x] `error` — обработка ошибок
- [x] `dm_send` / `dm_receive` — личные сообщения: сохраняются в Redis list `dm:{sorted(a:b)}` (TTL 7d, cap 100), доставляются всем вкладкам адресата и отправителя. REST: `GET /api/v1/dm/history?with={userId}` (через nginx напрямую, без Kong).

### Особенности реализации
- `safeSend` — RLock + select с default, предотвращает send-on-closed panic без блокировки broadcast loop
- `readyUsers` map: новый участник удаляется из map при join → `broadcastSyncStatus` отправляет `sync_pending` всем → все клиенты паузируют через `syncBlocked` prop (2026-04-27)
- При join с активным video — все клиенты блокируют воспроизведение overlay «подключается участник» до получения `all_synced`
- `roomBroadcasters` — не более одного broadcaster на комнату; автоочистка при дисконнекте
- `unicastSub` — per-client NATS подписка `room.{id}.user.{uid}` для unicast от sync-service

- [x] **WS handshake auth**: токен передаётся в URL (`?token=`) или заголовке `Authorization` при WS upgrade. Сервер верифицирует его через auth-service ещё до получения `join_room`. Клиент с валидным handshake-токеном получает верифицированный `UserID` — нельзя переопределить из payload `join_room`. Фронтенд: `useWebSocket` получает URL с токеном через `useMemo`.

## Не реализовано

- [ ] Горизонтальное масштабирование протестировано — Redis pub/sub код есть, но нагрузочного теста не было

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — JWT-токен проверяется при `join_room`
- [FEATURE_rooms](./FEATURE_rooms.md) — управление участниками (join/leave/kick)
- [FEATURE_sync](./FEATURE_sync.md) — трансляция `state_sync`, `sync_ready`, `all_synced`
- [FEATURE_chat](./FEATURE_chat.md) — доставка `chat_message` через WS
- [FEATURE_voice_rtc](./FEATURE_voice_rtc.md) — сигнализация `webrtc_offer/answer/ice`, `voice_*`, `stream_*`
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — событие `proxy_mode_enabled` рассылается через WS
- [FEATURE_infra](./FEATURE_infra.md) — Redis DB 1 (pub/sub для масштабирования), NATS (fan-out в сервисы)
- [FEATURE_admin](./FEATURE_admin.md) — broadcast сообщений по всем комнатам через WS Gateway
- [FEATURE_video_queue](./FEATURE_video_queue.md) — события video_action, video_select, video_updated проходят через WS
- [FEATURE_frontend](./FEATURE_frontend.md) — useWebSocket.js подключается к WS Gateway с exponential backoff reconnect
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong направляет WebSocket-трафик к Gateway (порт 8085)
- [FEATURE_monitoring](./FEATURE_monitoring.md) — метрика ws_gateway_active_connections в Prometheus

## Связанные файлы

- `services/ws-gateway/main.go` (~1420 строк)
- `services/ws-gateway/Dockerfile`
- `frontend/src/hooks/useWebSocket.js` — клиентская сторона с reconnect

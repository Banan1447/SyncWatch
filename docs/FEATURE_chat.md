---
title: Chat System
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, chat, scylladb, redis, nats, realtime]
---

# Chat System

## Описание
Real-time чат внутри комнат. История сообщений хранится в ScyllaDB с TTL 30 дней. Rate limiting через Redis. Доставка через NATS → WS Gateway.

**Порт:** 8087 (внешний), 8080 (внутренний)

## TODO

- [x] **Дублируются сообщения в личном чате (DM)** — исправлено. Удалён optimistic add из `sendDM` ([Player.jsx:222-228](frontend/src/pages/Player.jsx#L222-L228)) — теперь полагается только на echo `dm_receive` от ws-gateway, как уже сделано в room chat. Дубликат уходит автоматически
- [x] **TypeError "Cannot read properties of null (reading 'content')" при отправке сообщения в чат комнаты** — исправлено комплексно (в два прохода). Первый проход: defensive guards в `chat_message` handler + `.filter(Boolean)` + null guard перед map. Второй проход (2026-04-26): найдена вторая точка краша — мини-чат overlay (последние 15 сообщений) не имел `.filter(Boolean)` + null-guard. Исправлено: `messages.filter(Boolean).slice(-15).map()` + `msg?.content ?? ''`. Дополнительно: null-guard во всех state-апдейтах (`message_deleted`, `message_edited`, `deleteMessage`, `editMessage`) — `prev.filter(m => m && ...)` / `prev.map(m => m && m.message_id === id ? ... : m)`. Корень: бэкенд иногда возвращает `null` элементы в массиве истории → они попадают в `messages` state. ([Player.jsx](frontend/src/pages/Player.jsx))
- [x] **YouTube postMessage warning при отправке сообщения** — исправлено. В `playerVars` добавлены `enablejsapi: 1, origin: window.location.origin` ([VideoPlayer.jsx:173](frontend/src/components/VideoPlayer.jsx#L173)) — YouTube IFrame API теперь знает корректный target origin для postMessage

## Реализовано

- [x] Отправка сообщений (`POST /messages`)
- [x] История сообщений комнаты (`GET /messages/{roomId}`)
- [x] Real-time доставка через NATS pub/sub → WS Gateway
- [x] ScyllaDB хранение (keyspace `chat`, таблица `chat_messages`)
- [x] TTL: 30 дней (2,592,000 сек)
- [x] Rate limiting: 30 сообщений за 60 секунд (Redis DB 3)
- [x] Max длина сообщения: 2000 символов
- [x] Типы сообщений: text, emoji + metadata
- [x] Read receipts (`chat_read_receipts` в ScyllaDB)
- [x] Пагинация по timestamp (bucket + TIMEUUID clustering)
- [x] Реакции (reactions в metadata MAP)
- [x] Prometheus метрики: `chat_service_messages_processed_total`, `chat_service_rate_limit_hits_total`
- [x] WS события: `chat_message`, `reaction`, `message_deleted`
- [x] **Typing indicator** — реализован 2026-04-27. При наборе текста (debounce 300ms) клиент отправляет `chat_typing {username}`. ws-gateway транслирует в комнату (исключая отправителя, без Redis-персистентности). Получатели видят анимированные 3 точки + «X печатает…» над полем ввода. Исчезает через 3с или при приходе сообщения от пользователя. (`services/ws-gateway/main.go`, `frontend/src/pages/Player.jsx`, `frontend/src/index.css`)
- [x] Удаление сообщений: `DELETE /api/v1/rooms/{roomId}/messages/{messageId}` — проверка авторства в ScyllaDB, broadcast `message_deleted` через NATS → все клиенты комнаты убирают сообщение из списка. Кнопка `×` видна только автору сообщения.

## Не реализовано

- [x] Редактирование сообщений: `PATCH /rooms/{roomId}/messages/{messageId}` — проверка авторства, UPDATE в ScyllaDB, broadcast `message_edited`, inline-редактор с Escape-отменой, пометка `(ред.)` у отредактированных
- [x] Прикрепление файлов/изображений: кнопка 📎 в чате → выбор файла → POST `/api/v1/files/upload` (video-service) → сообщение с `attachment_url/name/type`. Изображения рендерятся inline (max 180×120), остальные — как ссылка. Хранится в ScyllaDB в `metadata MAP`. Нормализация: WS-сообщения (поля напрямую) и история из REST (`metadata`) обрабатываются одинаково.
- [x] **Личные сообщения (DM)**: WS-событие `dm_send` → ws-gateway сохраняет в Redis list `dm:{sorted(a:b)}` (TTL 7 дней, cap 100), доставляет `dm_receive` всем вкладкам адресата и отправителя. `GET /api/v1/dm/history?with={userId}` — история пары. Frontend: кнопка ✉️ у каждого зрителя и участника голоса → модал-чат справа снизу с историей и вводом.

## Связанные фичи

- [FEATURE_rooms](./FEATURE_rooms.md) — чат привязан к room_id
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — доставка сообщений через WebSocket в реальном времени
- [FEATURE_frontend](./FEATURE_frontend.md) — вкладка Чат в Player.jsx
- [FEATURE_infra](./FEATURE_infra.md) — ScyllaDB (история), Redis DB 3 (rate limit), NATS (доставка)
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong routing `/api/v1/rooms/{id}/messages/*`
- [FEATURE_monitoring](./FEATURE_monitoring.md) — Prometheus: chat_service_messages_processed_total, rate_limit_hits_total

## Связанные файлы

- `services/chat/main.go` (~374 строк)
- `services/chat/Dockerfile`
- `init/scylla/01_chat.cql` — схема keyspace chat
- `frontend/src/pages/Player.jsx` — вкладка Чат

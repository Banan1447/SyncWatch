---
title: Room System
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, rooms, postgresql, redis, nats]
---

# Room System

## Описание
Go-микросервис управления комнатами. Создание, присоединение, настройки, роли участников, пригласительные коды. Публикует события в NATS для синхронизации с другими сервисами.

**Порт:** 8083 (внешний), 8080 (внутренний)

## TODO

- [x] **POST /api/v1/rooms/{roomId}/join → 404 Not Found для комнат с паролем** — исправлено. Корень: в `handleJoinRoom` запрос `WHERE id = $1 OR slug = $1` сравнивал UUID-колонку с text-параметром, pgx/PostgreSQL возвращали zero rows → 404 `room_not_found`. Фикс: `id::text = $1` (как в работающем `handleGetRoom`). Тот же баг исправлен в `handleDeleteRoom` (ownership check + DELETE)

## Реализовано

- [x] Создание комнат (`POST /rooms`)
- [x] Список комнат (`GET /rooms`) — публичный эндпоинт
- [x] Получение комнаты по ID/slug (`GET /rooms/{id}`)
- [x] Редактирование настроек (`PUT /rooms/{id}`)
- [x] Удаление комнаты (`DELETE /rooms/{id}`)
- [x] Вступление в комнату (join/leave/kick через WS Gateway)
- [x] Роли участников: `viewer`, `moderator`, `owner`
- [x] Типы комнат: public, private (password), invite-only
- [x] Пригласительные коды (`/invitations` — код, TTL, max_uses)
- [x] PostgreSQL — таблицы `rooms`, `room_members`, `invitations`
- [x] Redis кэш состояния комнат (DB 0)
- [x] NATS публикация событий (join, leave, room_created, room_deleted)
- [x] TTL комнат: 24ч по умолчанию (когда `persistent: false`)
- [x] Max размер комнаты: 100 участников
- [x] **Persistent комнаты**: поле `persistent: true` в `POST /rooms` → `expires_at = NULL`, комната не удаляется автоматически. Goroutine `cleanupExpiredRooms` каждые 15 мин удаляет истёкшие (non-persistent) комнаты
- [x] **История событий комнаты**: таблица `room_events` (auto-migration при старте), NATS-подписки на `room.*.joined` / `room.*.left` / `room.*.broadcast`, эндпоинт `GET /rooms/{roomId}/events` (последние 100 событий). Kong route `room-events-route`

- [x] **Persistent UI в RoomSelect.jsx**: чекбокс «Постоянная комната» в модале создания, передаёт `persistent: true` в POST. На карточке комнаты иконка `∞` если `expires_at == null`.

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — только авторизованный пользователь может создать комнату
- [FEATURE_sync](./FEATURE_sync.md) — синхронизация видео привязана к комнате
- [FEATURE_chat](./FEATURE_chat.md) — чат привязан к room_id
- [FEATURE_video_queue](./FEATURE_video_queue.md) — очередь видео принадлежит комнате
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — join/leave/kick через WebSocket
- [FEATURE_infra](./FEATURE_infra.md) — PostgreSQL (rooms, room_members), Redis кэш, NATS события
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong routing `/api/v1/rooms/*`
- [FEATURE_admin](./FEATURE_admin.md) — управление комнатами из Admin панели
- [FEATURE_frontend](./FEATURE_frontend.md) — RoomSelect.jsx: список комнат, создание, вход
- [FEATURE_voice_rtc](./FEATURE_voice_rtc.md) — голосовой чат и screen share привязаны к комнате
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — proxy mode активируется для конкретной комнаты

## Связанные файлы

- `services/room/main.go` (~538 строк)
- `services/room/Dockerfile`
- `init/postgres/02_rooms.sql` — таблицы rooms, room_members, invitations
- `config/kong/kong.yml` — routing `/api/v1/rooms/*`

---
title: Admin Panel
status: done
progress: 100
last_audited: 2026-08-07
tags: [frontend, react, admin, docker, monitoring]
---

# Admin Panel

## Описание
React-страница для администратора. Мониторинг состояния всех сервисов, управление комнатами и пользователями, просмотр и перезапуск Docker-контейнеров, ссылки на внешние инструменты мониторинга.

## Реализовано

- [x] Дашборд с метриками (active rooms, users online, messages/sec)
- [x] Статус всех 12 сервисов (Auth, User, Room, Video, WS, Sync, Chat, Kong, Grafana, Prometheus, Jaeger, MinIO)
- [x] Управление комнатами: список, создание, удаление, мониторинг участников
- [x] Управление пользователями: список, блокировка, изменение ролей
- [x] Docker контейнеры: список (state/status), перезапуск, просмотр логов (через Auth Service Docker proxy)
- [x] Auto-refresh настройки (интервал обновления)
- [x] Быстрые ссылки: Grafana (3001), Prometheus (9090), Jaeger (16686), MinIO Console (9001)
- [x] CRUD пользователей `/api/admin/users`
- [x] Broadcast сообщений: `POST /api/v1/auth/admin/broadcast` → push-уведомление всем подписчикам. Форма «Заголовок + Текст» в Dashboard-вкладке Admin.jsx.
- [x] **Расширенное управление пользователями**: вкладка «Пользователи» — поиск по имени, кнопка «+ Создать», модальное окно создания пользователя (имя/email/пароль/роль), сброс пароля (кнопка «Пароль»), бан/разбан (кнопка «⊘ Бан / ✓ Разбан»), статусный столбец (Active/Banned/Admin), колонка «2FA» со статусом (Включена/Выключена/Требуется) и кнопками «⚑ Требовать 2FA» / «↺ Сбросить 2FA» (`POST /api/v1/auth/users/:id/totp/require|reset`).
- [x] **Улучшенная вкладка Логи**: выбор контейнера из dropdown (тёмная тема, `colorScheme: dark`), поиск/фильтр по строкам, color-coded строки (ERROR=красный, WARN=жёлтый, INFO=зелёный), кнопка «↓ Скачать» (текущий контейнер), кнопка «⬇ Все логи» — собирает логи всех контейнеров и скачивает единым .txt файлом.
- [x] **Ссылка на FileManager**: кнопка `📁 Файловый менеджер ↗` в заголовке табов Admin.jsx — открывает `/files` в новой вкладке.
- [x] **Улучшенный fallback UI инфра-секций**: ошибки NATS/Redis/ScyllaDB различают «Сервис не запущен (502/503)», «Таймаут» и «Нет соединения». Маршруты `/api/infra/nats/` и `/api/infra/scylla/` добавлены в `frontend/nginx.conf` (прямой прокси, минуя Kong).

## TODO

- [x] **NATS / Redis / ScyllaDB не отображаются в админке — «Нет соединения»** — исправлено: (1) добавлены маршруты `/api/infra/nats/` и `/api/infra/scylla/` в `frontend/nginx.conf` (прямой прокси на `nats:8222` и `scylla:10000`, минуя Kong); (2) улучшены сообщения об ошибках в Admin.jsx — различаем 502/503 («Сервис не запущен — контейнер остановлен»), таймаут, и «Нет соединения». Контейнеры `watchsync-nats`, `watchsync-redis`, `watchsync-scylla` должны быть запущены для отображения данных. (`frontend/nginx.conf`, `frontend/src/pages/Admin.jsx`)

## Не реализовано

- [x] **Просмотр логов в панели**: вкладка «Логи» — выбор контейнера из списка Docker, tail (50/100/200/500), фильтр по строке, ANSI-strip, color coding (ERROR=красный, WARN=жёлтый, INFO=зелёный). Кнопка «Обновить» + авто-скролл вниз. `fetchLogs` использует `GET /api/v1/auth/admin/docker/containers/:name/logs`. Кнопка «Логи» прямо из таблицы контейнеров Docker-вкладки переключает на Логи + загружает.
- [x] **Встроенный дашборд Grafana**: iframe в вкладке Сервисы (`/d/watchsync/watchsync?kiosk=tv&refresh=30s`). Grafana теперь запускается с `GF_AUTH_ANONYMOUS_ENABLED=true` + `GF_SECURITY_ALLOW_EMBEDDING=true` в docker-compose. Ссылка «Открыть в Grafana ↗».
- [x] **NATS мониторинг в панели**: вкладка Сервисы → раздел «⚡ NATS JetStream» — 8 метрик: версия, соединения, подписки, сообщений in/out, байт in, CPU%, память. Данные из `/api/infra/nats/varz` (nginx proxy → nats:8222/varz, CORS-safe). Кнопка Обновить.
- [x] **Redis управление**: вкладка Сервисы → раздел «🔴 Redis» — 8 метрик (версия, роль, клиенты, ключи, память, пик памяти, команды, hit rate). Кнопки Flush DB и Flush ALL. Данные из `GET /api/v1/auth/admin/redis/info`. Flush через `POST /api/v1/auth/admin/redis/flush`.
- [x] **ScyllaDB мониторинг**: вкладка Сервисы → раздел «🔷 ScyllaDB» — список keyspaces. Данные из `/api/infra/scylla/storage_service/keyspaces` (nginx proxy → scylla:10000). Кнопка Обновить.

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — Docker API прокси в Auth Service, управление пользователями
- [FEATURE_frontend](./FEATURE_frontend.md) — Admin.jsx страница (часть фронтенда)
- [FEATURE_monitoring](./FEATURE_monitoring.md) — ссылки на Grafana, Prometheus, Jaeger
- [FEATURE_infra](./FEATURE_infra.md) — отображение статуса контейнеров (PostgreSQL, Redis, MinIO и др.)
- [FEATURE_rooms](./FEATURE_rooms.md) — управление комнатами из панели
- [FEATURE_file_manager](./FEATURE_file_manager.md) — ссылка на файловый менеджер из Admin панели
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Admin.jsx обращается к REST API через Kong
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — broadcast сообщений по всем комнатам через WS Gateway
- [FEATURE_mcp](./FEATURE_mcp.md) — project-mcp: docker_containers() использует тот же Docker API

## Связанные файлы

- `frontend/src/pages/Admin.jsx` (~42KB)
- `services/auth/main.go` — Docker API прокси для контейнеров

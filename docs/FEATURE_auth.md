---
title: Auth Service
status: in_progress
progress: 85
last_audited: 2026-08-07
tags: [backend, go, auth, jwt, postgresql, redis, bcrypt, docker]
---

# Auth Service

## Описание
Go-микросервис аутентификации и авторизации. Обрабатывает регистрацию, вход, JWT-токены, проверку прав. Также содержит прокси к Docker API для управления контейнерами (используется Admin-панелью).

**Порт:** 8081 (внешний через Kong), 8080 (внутренний)

## Реализовано

- [x] Регистрация пользователей (`POST /api/v1/auth/register`)
- [x] Вход / выдача JWT (`POST /api/v1/auth/login`)
- [x] Refresh токенов (`POST /api/v1/auth/refresh`)
- [x] Logout с инвалидацией refresh-токена (`POST /api/v1/auth/logout`)
- [x] Получение своего профиля (`GET /api/v1/auth/me`)
- [x] Верификация токена для внутренних сервисов (`POST /api/v1/auth/verify`)
- [x] **bcrypt** хэширование паролей (cost 12) — _не PBKDF2_
- [x] Access token TTL: 15m, Refresh token TTL: 168h (7 дней), хранение в Redis (DB 0)
- [x] PostgreSQL — таблица `users` (id, username, email, password_hash, subscription_tier, avatar_url, preferences JSONB)
- [x] Роли: `free`, `premium`, `admin` (через `subscription_tier`)
- [x] Seed default admin (`admin`/`admin`) при пустой БД
- [x] Управление пользователями (GET list, DELETE, PATCH role) для admin-роли
- [x] Docker API прокси (unix socket `/var/run/docker.sock`):
  - `GET /api/v1/auth/admin/docker/containers` — список контейнеров
  - `POST /api/v1/auth/admin/docker/containers/:name/start|stop|restart`
  - `GET /api/v1/auth/admin/docker/containers/:name/logs` — с парсингом stream-framing заголовков

## TODO

### 🔒 Полная проверка безопасности — отложено до завершения авторизации

> Выполнить после реализации групп доступа, анонимных разрешений и всей auth-инфраструктуры.

- [ ] **OWASP Top 10 аудит** — проверить все эндпоинты на SQL injection (pgx параметризованные запросы — ок, но проверить ручные конкатенации), XSS (Content-Security-Policy заголовки в nginx), CSRF (SameSite cookie / Origin проверка на WS), Path Traversal (MinIO key sanitization в video service), Server-Side Request Forgery (proxy-url эндпоинт — фильтровать internal IPs). (`services/auth/main.go`, `services/video/main.go`, `frontend/nginx.conf`)
- [ ] **JWT hardening** — проверить что `alg: none` атаки невозможны (Kong JWT plugin отклоняет unsigned tokens). Rotation: добавить `jti` (JWT ID) в claims → хранить в Redis blacklist при logout. Сейчас logout инвалидирует только refresh-токен, access-токен живёт до TTL=15min. (`services/auth/main.go`)
- [ ] **Rate limiting** — добавить Kong rate-limit plugin на `/api/v1/auth/login` (5 попыток/мин/IP), `/api/v1/auth/register` (3/мин/IP), `/api/v1/auth/anonymous` (10/мин/IP). Сейчас нет брутфорс-защиты. (`config/kong/kong.yml`)
- [ ] **Secrets rotation** — JWT_SECRET из env, но нет механизма ротации без перезапуска сервиса. Добавить поддержку dual-key rotation (old+new secret, период перехода 1h). (`services/auth/main.go`)
- [ ] **WebSocket auth** — WS-соединение принимает токен в query param `?token=...`. Query params логируются в nginx/Kong access log → токен попадает в логи. Фикс: принимать токен в первом WS-сообщении (`auth` event) или в `Authorization` header при upgrade. (`services/ws-gateway/main.go`)
- [ ] **MinIO public access** — проверить что MinIO bucket policy не даёт публичный read без токена. Сейчас `/api/v1/videos/stream/` проксируется без проверки принадлежности файла пользователю — любой аутентифицированный пользователь может стримить чужой файл по известному ключу. Добавить ownership check в `handleStreamVideo`. (`services/video/main.go`)
- [ ] **Admin endpoints** — Docker API прокси (`/api/v1/auth/admin/docker/*`) доступен любому `admin`-роль пользователю. Добавить IP whitelist (только localhost/internal network) или отдельный internal-only сервис. (`services/auth/main.go`)
- [ ] **Dependency audit** — `go mod tidy` + `govulncheck ./...` для всех Go сервисов. `npm audit` для frontend и desktop. Добавить в GitHub Actions CI.

### 👥 Группы доступа и права анонимных пользователей

#### Анонимные пользователи — глобальная группа с настройкой из админки

- [ ] **Таблица `permission_groups`** в PostgreSQL: `(id, name, is_global, is_anonymous_default, permissions JSONB)`. Permissions — объект с ключами: `can_join_room`, `can_create_room`, `can_upload_file`, `can_use_mic`, `can_stream`, `can_chat`, `can_add_to_queue`, `can_use_proxy`, `can_invite`. (`init/postgres/01_users.sql` или новый `08_permissions.sql`)
- [ ] **Дефолтная группа `anonymous`** — при seed БД создаётся с базовыми правами: `{ can_join_room: true, can_chat: true, can_add_to_queue: false, can_use_mic: false, can_stream: false, can_upload_file: false }`. Эту группу нельзя удалить, только изменить.
- [ ] **Дефолтная группа `registered`** — для зарегистрированных пользователей без явной группы: все права включены.
- [ ] **Auth service** — при `/api/v1/auth/me` и `/api/v1/auth/verify` включать `permissions` объект в ответ. WS Gateway и Video Service проверяют `permissions` из JWT claims или через internal verify call. (`services/auth/main.go`)
- [ ] **Kong JWT plugin** — добавить `permissions` в JWT payload при выдаче токена, чтобы микросервисы могли проверять права без roundtrip к auth service.

#### Управление группами из Admin-панели

- [ ] **API группп** в auth service: `GET/POST /api/v1/admin/groups`, `PATCH /api/v1/admin/groups/:id`, `DELETE /api/v1/admin/groups/:id`, `POST /api/v1/admin/groups/:id/assign-user`. (`services/auth/main.go`)
- [ ] **Admin.jsx** — новая вкладка «Группы»: список групп, создание новой, редактирование прав через набор toggles (`can_use_mic`, `can_stream` и т.д.), назначение пользователей на группу. Отдельный блок «Анонимные» с быстрыми toggles.
- [ ] **Права в UI** — Player.jsx: скрывать/disabled кнопки (загрузка файла, микрофон, трансляция) если у пользователя нет соответствующего permission. Использовать `AuthContext.user.permissions`.
- [ ] **WS Gateway enforcement** — при `join_room`, `voice_join`, `stream_start` проверять permissions. Отклонять с `{ type: 'error', code: 'PERMISSION_DENIED', action: '...' }`. (`services/ws-gateway/main.go`)

## Не реализовано

- [x] Email-верификация при регистрации — [FEATURE_email_verification](./FEATURE_email_verification.md)
- [ ] OAuth 2.0 / социальный вход (Google, GitHub) — не запланировано
- [x] **2FA / TOTP**: `POST /totp/setup` → генерирует секрет + otpauth URI (хранится в Redis 10 мин). `POST /totp/enable` → валидирует код, сохраняет `totp_secret` в `users.preferences JSONB` (и снимает `totp_required`). `POST /totp/disable` → требует валидный код. Login: если totp_secret задан — возвращает `{totp_required:true, temp_token}` (5 мин в Redis), клиент вводит код → `POST /totp/verify` → полные токены. Frontend: кнопка «🔐 2FA» в хедере RoomSelect, модал с otpauth URI + секретом + подтверждением кода. TOTP шаг при входе с 6-значным вводом. `/auth/me` и `/auth/users` возвращают `totp_enabled` + `totp_required`.
- [x] **2FA управление в админке + принудительная настройка**: Admin.jsx — колонка «2FA» со статусом (Включена/Выключена/Требуется) и кнопками «⚑ Требовать 2FA» / «↺ Сбросить 2FA». `POST /api/v1/auth/users/:id/totp/require` → сбрасывает текущий секрет и ставит `totp_required=true`; `POST /api/v1/auth/users/:id/totp/reset` → снимает секрет и требование (инвалидирует refresh). При входе с `totp_required` без секрета login возвращает `{totp_setup_required:true, temp_token}` (10 мин, `totp:setup:*`), клиент открывает принудительный модал настройки; `setup`/`enable` принимают `temp_token` (без JWT — Kong route `auth-public`), enable возвращает полные токены и завершает вход. Багфикс: после настройки UI обновляет `totp_enabled` через `AuthContext.refreshUser()` и больше не предлагает настроить заново.
- [x] **Анонимная / privacy-first авторизация**: `POST /api/v1/auth/anonymous` → генерирует случайный username (`anon_XXXXXXXX`) + 32-байтный токен как пароль (bcrypt). Нет email, нет PII. Ответ: `{ access_token, refresh_token, anon_token, username, is_anonymous: true }`. Клиент хранит `anon_token` в localStorage для повторного входа через обычный `/login`. Кнопка «Анонимно» на RoomSelect. Silent restore: при протухшем JWT re-auth через хранённый anon_token.

## Связанные фичи

- [FEATURE_rooms](./FEATURE_rooms.md) — комнаты требуют JWT для создания/управления
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — WS Gateway проверяет токен при `join_room`
- [FEATURE_frontend](./FEATURE_frontend.md) — AuthContext, login/register модали, localStorage
- [FEATURE_admin](./FEATURE_admin.md) — управление пользователями через admin API
- [FEATURE_infra](./FEATURE_infra.md) — PostgreSQL (users), Redis (сессии DB 0)
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong JWT plugin для protected routes
- [FEATURE_monitoring](./FEATURE_monitoring.md) — /metrics эндпоинт Auth Service собирается Prometheus

## Связанные файлы

- `services/auth/main.go` — основная логика (~824 строк)
- `services/auth/Dockerfile`
- `services/auth/go.mod`
- `init/postgres/01_users.sql`
- `config/kong/kong.yml` — routing `/api/v1/auth/*`

---
title: API Gateway (Kong + NGINX)
status: done
progress: 100
last_audited: 2026-08-07
tags: [infrastructure, kong, nginx, api-gateway, routing, cors, jwt]
---

# API Gateway

## Описание
Kong API Gateway (декларативный конфиг) для маршрутизации, JWT-проверки и rate limiting. NGINX как reverse proxy для фронтенда и статики.

## Реализовано

### Kong (порты 8000 proxy, 8001 admin)
- [x] Декларативный конфиг: `config/kong/kong.yml`
- [x] Routes для всех сервисов:
  - `POST /api/v1/auth/login`, `/auth/register`, `/auth/refresh` — публичные
  - `GET /api/v1/auth/me`, `/api/v1/users/*` — защищённые (JWT)
  - `GET /api/v1/rooms` — публичный
  - `POST/PATCH/DELETE /api/v1/rooms/*` — защищённые
  - `/api/v1/rooms/{id}/queue/*` — Video Service
  - `/api/v1/rooms/{id}/messages/*` — Chat Service
  - `/api/v1/rooms/{id}/proxy-url`, `/proxy-config` — Proxy Mode
  - `GET/DELETE /api/v1/files` — File Manager (список/удаление файлов)
  - `POST/DELETE /api/v1/files/folder` — создание/удаление папок
  - `POST /api/v1/files/move` — перемещение/переименование
  - `POST /api/v1/files/fm-upload` — загрузка через File Manager
- [x] Plugin: `rate-limiting` (по маршруту)
- [x] Plugin: `cors` (origins: *)
- [x] Plugin: `jwt` (для protected routes)
- [x] Declarative mode (`KONG_DATABASE: "off"`)

### NGINX (порт 80)
- [x] Reverse proxy для фронтенда (React)
- [x] Раздача статической сборки
- [x] Кэш: `/var/cache/nginx`
- [x] Config: `config/nginx/nginx.conf`

- [x] **Custom error pages**: NGINX `error_page` 401/403/404/429/502/503/504 → JSON-ответы (`{"error":"...","message":"..."}`). `proxy_intercept_errors on` для `/api/` и `/api/v1/auth`. `limit_req_status 429` для rate-limited запросов.
- [x] **Rate limiting лимиты задокументированы**: NGINX: auth=10r/s burst=20, api=100r/s burst=200. Kong: auth=30/min, rooms=60/min, video=120/min, chat=200/min, user=100/min.

## Не реализовано

- [x] **HTTPS/TLS termination на NGINX**: entrypoint-скрипт `config/nginx/entrypoint.sh` генерирует self-signed RSA-4096 сертификат (SAN: watchsync.local, localhost, 127.0.0.1, 10 лет) при первом запуске → `/etc/nginx/ssl/cert.pem|key.pem` (volume `nginx_ssl`). Nginx: порт 443 (ssl, TLSv1.2/1.3), порт 80 → 301 redirect на HTTPS. docker-compose: порты 80+443, entrypoint mount.

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — Kong JWT plugin, routes `/api/v1/auth/*`
- [FEATURE_rooms](./FEATURE_rooms.md) — Kong routes `/api/v1/rooms/*`
- [FEATURE_video_queue](./FEATURE_video_queue.md) — Kong routes `/api/v1/rooms/{id}/queue/*`
- [FEATURE_chat](./FEATURE_chat.md) — Kong routes `/api/v1/rooms/{id}/messages/*`
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) — Kong routes `/proxy-url`, `/proxy-config`
- [FEATURE_file_manager](./FEATURE_file_manager.md) — Kong routes `/api/v1/files/*`
- [FEATURE_frontend](./FEATURE_frontend.md) — NGINX раздаёт React SPA
- [FEATURE_admin](./FEATURE_admin.md) — Kong обрабатывает запросы `/api/admin/*` к Auth Service
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — Kong routing WebSocket-соединений к WS Gateway (порт 8085)
- [FEATURE_infra](./FEATURE_infra.md) — Kong и NGINX развёртываются как сервисы в docker-compose
- [FEATURE_monitoring](./FEATURE_monitoring.md) — Kong метрики и NGINX status → Prometheus

## Связанные файлы

- `config/kong/kong.yml` — полный декларативный конфиг
- `config/nginx/nginx.conf`
- `docker-compose.yml` — kong, nginx сервисы

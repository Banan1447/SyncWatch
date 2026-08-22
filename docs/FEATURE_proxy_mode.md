---
title: Server Proxy Viewing Mode
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, proxy, flaresolverr, cors, streaming, redis, cache, upstream]
---

# Server Proxy Viewing Mode

## Описание
Режим, при котором сервер выступает прокси для видеоконтента. Позволяет клиентам обходить CORS, geo-блокировки, Cloudflare. Контент проксируется через Video Service → FlareSolverr (если нужен обход Cloudflare) → клиент.

**Архитектурное решение описано в:** `CLAUDE.md`, `Server Proxy Mode (Architecture & Implementation).md`

## TODO

- [x] **Proxy URL рекурсивно проксирует себя — 502** — исправлено на двух уровнях: (1) **Frontend guard** в `enableProxyMode` (`Player.jsx`) — если URL уже начинается с `/api/v1/rooms` или `blob:`, вызов отклоняется без обращения к серверу; (2) **Server guard** в `handleProxyURL` (`services/video/main.go`) — если `url`-параметр содержит `/api/v1/rooms/` + `/proxy-url` или начинается с `blob:`, возвращает 400 Bad Request с кодом `self_proxy`/`blob_url`.

- [x] **Прокси не работает — диагностика и фикс** — найдены и исправлены 2 критических проблемы:
  1. **Kong timeout 60s → 300s** — `video-service` в `kong.yml` теперь имеет `read_timeout: 300000, write_timeout: 300000`. Без этого Kong разрывал соединение через 60с, убивая стримы.
  2. **HLS m3u8 сегменты не проксировались** — добавлена `rewriteM3U8()` в `handleProxyURL`: при ответе с Content-Type `mpegurl` или URL с `.m3u8` перезаписывает все URL сегментов/плейлистов относительно base URL через `?url=` прокси. Без этого браузер тянул сегменты напрямую, полностью обходя прокси.
  3. **Referer forwarding** — добавлен `Referer: {origin}/` header к upstream-запросу (CDN часто проверяют referrer).
  - *TODO (осталось диагностировать при воспроизведении):* mixed content при HTTPS→HTTP апстрим, Kong CORS preflight, проверить реальный DevTools flow.


- [x] **Шаг 1: PostgreSQL-схема + CRUD API** — таблица `proxy_upstreams` (id UUID, name, description, type enum(direct/http_proxy/socks5/flaresolverr), endpoint, auth JSONB, rules JSONB, priority, enabled). CRUD: `GET/POST /api/v1/proxy/upstreams`, `PUT/DELETE /api/v1/proxy/upstreams/{id}`, `POST /api/v1/proxy/upstreams/{id}/test` (реальный HEAD-запрос через выбранный upstream, возвращает ok/latency_ms/error). Admin UI: вкладка «🛡 Прокси» в Admin.jsx — таблица upstream'ов, кнопки включить/выключить, тест, удалить, форма создания. Kong routes: `proxy-upstreams` (GET+POST, JWT), `proxy-upstream-item` (PUT+DELETE+POST, regex, JWT). (`services/video/main.go`, `init/postgres/04_proxy_upstreams.sql`, `config/kong/kong.yml`, `frontend/src/pages/Admin.jsx`)
- [x] **Шаги 2-5: Auto-routing, health-checks, метрики, generic fetch** — реализованы в `services/video/main.go`:
  - `selectUpstream(ctx, targetURL)` — запрашивает из PostgreSQL включённые апстримы (ORDER BY priority), проверяет rules JSONB (regex по host), возвращает первый совпавший
  - `buildProxyTransport(u)` — создаёт `http.Transport` для direct/http_proxy/socks5/flaresolverr
  - `startHealthCheckLoop()` + `runHealthChecks()` — goroutine, каждые 60с проверяет все upstream, пишет в `upstreamHealthMap` (sync.Map)
  - `handleProxyHealth` — `GET /api/v1/proxy/health` — отдаёт cached статус всех upstream
  - `handleProxyFetch` — `GET /api/v1/proxy/fetch?url=&via=` — generic proxy через auto-routing или конкретный upstream
  - Prometheus metrics: `proxy_upstream_requests_total`, `proxy_upstream_errors_total`, `proxy_upstream_duration_seconds`, `proxy_upstream_bytes_total` (labels: upstream_id, upstream_name)
  - `handleProxyURL` теперь использует `selectUpstream()` + инкрементирует метрики
  - Kong routes: `proxy-fetch` (GET /api/v1/proxy/fetch, JWT), `proxy-health` (GET /api/v1/proxy/health, JWT)
- [x] **Шаг 6: Chains** — цепочки upstream-провайдеров реализованы в `services/video/main.go`:
  - `chain_ids JSONB` поле в `proxy_upstreams` — упорядоченный массив ID апстримов через которые туннелируется трафик
  - `init/postgres/05_proxy_chains.sql` — миграция добавляет колонку `chain_ids`
  - `httpConnectDialer` — реализует `proxy.Dialer` для HTTP CONNECT туннелирования
  - `buildDialerStack(ups)` — стекует `socks5` и `http_proxy` апстримы в цепочку `proxy.Dialer`
  - `buildChainedTransport(chainUps, final)` — создаёт `http.Transport` с DialContext через цепочку, учитывает тип конечного апстрима (socks5/http_proxy/direct/flaresolverr)
  - `loadChainUpstreams(ctx, u)` — загружает апстримы из chain_ids из БД
  - `buildClientForUpstream(ctx, u)` — единая точка создания `http.Client` для любого апстрима (с/без цепочки)
  - `buildProxyTransport` теперь корректно обрабатывает `socks5` через `golang.org/x/net/proxy`
  - CRUD (`createProxyUpstream`, `updateProxyUpstream`, `listProxyUpstreams`) — поддерживают `chain_ids`
  - Admin UI — multi-select «Цепочка» в форме создания + колонка в таблице с именами chain-апстримов

## Реализовано

- [x] Архитектурное решение принято и задокументировано в CLAUDE.md
- [x] FlareSolverr контейнер в docker-compose (порт 8191, `FLARESOLVERR_URL` env в video-service)
- [x] `POST /api/v1/embed/extract` — реальная точка входа FlareSolverr: получает HTML через headless Chrome, извлекает embed URL (kodik/alloha/ashdi/moonwalk/m3u8) regex-парсером (3 прохода: data-player → JSON field → iframe src → loose match). Fallback — прямой HTTP с `InsecureSkipVerify`.

- [x] `GET /api/v1/rooms/{roomId}/proxy-url?url={original}` — HTTP proxy с forwarding Range-заголовков (HTTP 206), CORS-хедеры, `InsecureSkipVerify` для CDN с самоподписанными сертами, без таймаута (стриминг)
- [x] `POST /api/v1/rooms/{roomId}/proxy-config` — stateless: принимает `{url, enabled}`, возвращает `{proxy_url, proxy_mode_enabled, original_url}`. Клиент сам делает `video_select` с proxy URL — все зрители переключаются автоматически через WS.
- [x] Kong routing: `proxy-url-route` (GET, regex, rate-limit 3000/min), `proxy-config-route` (POST)
- [x] Frontend: кнопка "🛡 Включить прокси" в вкладке Видео → `enableProxyMode()` → `POST /proxy-config` → `video_select`. Кнопка "Отключить прокси" восстанавливает исходный URL.
- [x] `proxyMode` state сбрасывается при `video_updated` от другого пользователя

## Реализовано (продолжение)

- [x] Персистирование proxy mode в Redis (`room:{id}:proxy_mode`) через ws-gateway при `video_select` с `proxy_mode: true`
- [x] Восстановление proxy mode для опоздавших — `room_init` включает `proxy_mode` payload из Redis
- [x] Frontend восстанавливает `proxyMode` state и `originalVideoRef` при получении `room_init`
- [x] E2E тесты proxy mode в `services/test-work/test.mjs`: proxy-config, персистирование, сброс состояния

## Реализовано (продолжение 2)

- [x] Кэширование проксируемых чанков в Redis DB 2 (`proxy_chunk:{sha256_prefix}`) — TTL 10 мин, лимит ≤512 KB (HLS-сегменты). Только для Range-запросов. Cache HIT отдаёт `X-Cache: HIT`, не делая запрос к источнику. Снижает нагрузку при >10 зрителей.

## Реализовано (продолжение 3)

- [x] **SOCKS5 транспорт** — `buildProxyTransport` теперь корректно строит SOCKS5 dialer через `golang.org/x/net/proxy`; аутентификация из `auth.username`/`auth.password` JSON-поля
- [x] **Цепочки upstream-провайдеров** — поле `chain_ids JSONB` в таблице `proxy_upstreams`; `buildDialerStack` стекует socks5/http_proxy апстримы; `buildChainedTransport` собирает итоговый `http.Transport`; `buildClientForUpstream` — единая точка сборки клиента
- [x] **Admin UI для цепочек** — multi-select «Цепочка» в форме создания; колонка «Цепочка» в таблице апстримов с именами chain-апстримов

## Связанные фичи

- [FEATURE_video_queue](./FEATURE_video_queue.md) — proxy URL генерируется для видео из очереди
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — событие `proxy_mode_enabled` рассылается всем клиентам
- [FEATURE_frontend](./FEATURE_frontend.md) — VideoPlayer.jsx должен переключиться на proxy URL
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong routing `/proxy-url`, `/proxy-config`
- [FEATURE_infra](./FEATURE_infra.md) — FlareSolverr контейнер для обхода Cloudflare
- [FEATURE_sync](./FEATURE_sync.md) — Sync Service обновляет метаданные комнаты при proxy_mode_enabled
- [FEATURE_rooms](./FEATURE_rooms.md) — proxy mode активируется в контексте конкретной комнаты

## Связанные файлы

- `CLAUDE.md` — архитектурное решение и спека
- `Server Proxy Mode (Architecture & Implementation).md` — детальная документация
- `services/video/main.go` — proxy эндпоинты + handleProxyUpstreams CRUD + chain реализация
- `init/postgres/04_proxy_upstreams.sql` — схема таблицы proxy_upstreams
- `init/postgres/05_proxy_chains.sql` — миграция: добавляет колонку chain_ids
- `config/kong/kong.yml` — routing proxy URLs
- `docker-compose.yml` — flaresolverr сервис
- `frontend/src/components/VideoPlayer.jsx` — требует доработки для proxy mode

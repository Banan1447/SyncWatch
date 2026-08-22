---
title: Monitoring & Observability
status: done
progress: 100
last_audited: 2026-08-07
tags: [monitoring, prometheus, grafana, jaeger, loki, alertmanager, telegram, observability]
---

# Monitoring & Observability

## Описание
Полный стек наблюдаемости: Prometheus (метрики), Grafana (дашборды), Jaeger (distributed tracing), Loki (логи), Promtail (log shipping). Node/Redis/Postgres exporters.

## Реализовано

### Prometheus (порт 9090)
- [x] Сбор метрик всех Go-сервисов (эндпоинт `/metrics`)
- [x] Node Exporter (порт 9100) — системные метрики
- [x] Redis Exporter (порт 9121)
- [x] PostgreSQL Exporter (порт 9187)
- [x] Retention: 15 дней
- [x] Config: `config/prometheus/prometheus.yml`

### Grafana (порт 3001)
- [x] Data source: Prometheus
- [x] Дашборд watchsync.json (все сервисы)
- [x] Provisioning через `config/grafana/`
- [x] Логин: admin / (из .env)

### Jaeger (порт 16686)
- [x] Distributed tracing UI
- [x] OTLP collector (порты 4317 gRPC, 4318 HTTP)
- [x] Трейсинг из Go-сервисов

### Loki (порт 3100)
- [x] Log aggregation
- [x] Config: `config/loki/loki.yml`

### Promtail
- [x] Сбор логов Docker-контейнеров
- [x] Отправка в Loki
- [x] Config: `config/promtail/promtail.yml`

### Alertmanager (порт 9093)
- [x] Alertmanager сервис в docker-compose (порт 9093, volume `alertmanager_data`)
- [x] Alert rules: `config/prometheus/alerts/watchsync.yml` — 15 правил:
  - ServiceDown, WSGatewayDown, AuthServiceDown (critical, 30s)
  - HighConnectionCount (>80k), CriticalConnectionCount (>95k), HighRoomCount
  - RedisDown, PostgresDown, HighRedisMemory, RedisKeyEviction, PostgresConnectionsHigh
  - HighCPU (>85%), CriticalCPU (>95%), HighMemory, DiskSpaceLow/Critical
  - NATSDown
- [x] Telegram receiver: critical (1h repeat) и warning (6h repeat) каналы
- [x] Inhibition rules: ServiceDown подавляет warning того же job
- [x] Config: `config/alertmanager/alertmanager.yml`
- [x] `.env.example` обновлён: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

## Не реализовано

- [x] **Grafana-native alerts**: `config/grafana/alerting/alerts.yml` (provisioning) — 5 правил: WS Gateway Down (critical, 2m), Auth Service Down (critical, 2m), High WS Connections >5000 (warning, 5m), High Transcode Fail Rate (warning, 5m), Chat Rate Limit Elevated (info, 3m). Mount добавлен в docker-compose. `GF_AUTH_ANONYMOUS_ENABLED=true` + `GF_SECURITY_ALLOW_EMBEDDING=true` для iframe в Admin.

## Связанные фичи

- [FEATURE_infra](./FEATURE_infra.md) — node/redis/postgres exporters как источники метрик
- [FEATURE_admin](./FEATURE_admin.md) — Admin.jsx содержит ссылки на Grafana, Prometheus, Jaeger
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — метрики активных соединений
- [FEATURE_sync](./FEATURE_sync.md) — `sync_service_*` метрики в Prometheus
- [FEATURE_chat](./FEATURE_chat.md) — `chat_service_*` метрики
- [FEATURE_transcoder](./FEATURE_transcoder.md) — `transcoder_*` метрики
- [FEATURE_auth](./FEATURE_auth.md) — auth_service /metrics эндпоинт → Prometheus scraping
- [FEATURE_rooms](./FEATURE_rooms.md) — room_service метрики через NATS события
- [FEATURE_video_queue](./FEATURE_video_queue.md) — video_service_* метрики в Prometheus
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong upstream stats и NGINX status → Prometheus
- [FEATURE_voice_rtc](./FEATURE_voice_rtc.md) — media сервис (Mediasoup) в docker-compose → Node Exporter

## Связанные файлы

- `config/prometheus/prometheus.yml`
- `config/prometheus/alerts/watchsync.yml`
- `config/alertmanager/alertmanager.yml`
- `config/grafana/datasources/prometheus.yml`
- `config/grafana/dashboards/watchsync.json`
- `config/loki/loki.yml`
- `config/promtail/promtail.yml`
- `docker-compose.yml` — сервисы monitoring профиля

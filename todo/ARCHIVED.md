# ARCHIVED — Source Material

This folder contains the original architectural plan and reference implementations used during the WatchSync Platform rewrite (Stages 1–11).

All content has been implemented. The `todo/` folder is kept for reference only.

## What was used from here

| File | Used for |
|------|----------|
| [video_sync_platform_plan](video_sync_platform_plan.md) | Architecture reference, DB schemas, CRDT algorithm |
| `docker-compose.yml` | Base for new `docker-compose.yml` (root) |
| `services/ws-gateway/` | Base for `services/ws-gateway/` |
| `services/sync/` | Base for `services/sync/` |
| `frontend/src/components/VideoPlayer.jsx` | Adapted into `frontend/src/components/VideoPlayer.jsx` |
| `frontend/src/hooks/useWebSocket.js` | Copied to `frontend/src/hooks/useWebSocket.js` |
| `config/coturn/turnserver.conf` | Copied to `config/coturn/turnserver.conf` |
| `config/kong/kong.yml` | Copied to `config/kong/kong.yml` |
| `config/nginx/nginx.conf` | Adapted into `config/nginx/nginx.conf` |
| `config/prometheus/prometheus.yml` | Copied to `config/prometheus/prometheus.yml` |

## Rewrite completed: 2026-03-22

All 11 stages complete. See root [CLAUDE.md](../CLAUDE.md) for full architecture documentation.

## Update: 2026-08-07

- **`archive/test-work` restored to `services/test-work`** — the test-work service was moved out of archive back into active services during Phase H of the refactoring (see [Refactoring_Log.md](../Refactoring_Log.md)).

---

## Актуальная документация

- [index](../docs/index.md) — центральный хаб документации платформы
- [featuremap](../docs/featuremap.md) — статус всех фич
- [FEATURE_auth](../docs/FEATURE_auth.md) | [FEATURE_rooms](../docs/FEATURE_rooms.md) | [FEATURE_sync](../docs/FEATURE_sync.md) | [FEATURE_ws_gateway](../docs/FEATURE_ws_gateway.md)
- [FEATURE_chat](../docs/FEATURE_chat.md) | [FEATURE_video_queue](../docs/FEATURE_video_queue.md) | [FEATURE_transcoder](../docs/FEATURE_transcoder.md) | [FEATURE_voice_rtc](../docs/FEATURE_voice_rtc.md)
- [FEATURE_frontend](../docs/FEATURE_frontend.md) | [FEATURE_api_gateway](../docs/FEATURE_api_gateway.md) | [FEATURE_infra](../docs/FEATURE_infra.md) | [FEATURE_monitoring](../docs/FEATURE_monitoring.md)

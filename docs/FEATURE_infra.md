---
title: Infrastructure (Databases & Messaging)
status: done
progress: 100
last_audited: 2026-08-07
tags: [infrastructure, postgresql, redis, scylladb, minio, nats, docker]
---

# Infrastructure

## Description
Full infrastructure stack: PostgreSQL (primary data), Redis (cache/sessions/pub-sub), ScyllaDB (chat history), MinIO (files), NATS (async messaging). All deployed via docker-compose.

## Implemented

### PostgreSQL (port 5432)
- [x] DB: `watchsync`
- [x] Tables: `users`, `rooms`, `room_members`, `invitations`, `video_queue`
- [x] JSONB fields for flexible schema (settings, preferences, video_metadata, current_state)
- [x] Indexes on key fields
- [x] Init scripts in `init/postgres/`
- [x] Metrics exporter (port 9187) for Prometheus

### Redis (port 6379)
- [x] DB 0: Auth sessions and cache
- [x] DB 1: WS Gateway connection state
- [x] DB 2: Sync Service video state
- [x] DB 3: Chat rate limiting
- [x] DB 4: Transcoder job queue
- [x] Max memory: 1GB, policy: volatile-lru
- [x] Persistence: AOF
- [x] Metrics exporter (port 9121)

### ScyllaDB (ports 9042, 9180)
- [x] Keyspace: `chat`
- [x] Table `chat_messages` (partition by room_id+bucket, TIMEUUID, TTL 30 days)
- [x] Table `chat_read_receipts`
- [x] Init CQL script in `init/scylla/`

### MinIO (ports 9000, 9001)
- [x] Buckets: `videos`, `thumbnails`, `avatars`
- [x] S3-compatible API
- [x] Public access for videos/thumbnails/avatars
- [x] Web Console on port 9001
- [x] File Manager API: folder listing (prefix/non-recursive), virtual folder creation (zero-byte marker), recursive folder delete, move (CopyObject+RemoveObject), upload to arbitrary prefix

### NATS (ports 4222, 8222)
- [x] JetStream enabled (`--js`)
- [x] Store dir: `/data/jetstream`
- [x] Health endpoint: 8222
- [x] Used for: room events, video sync, chat delivery, transcode jobs

### Additional Infrastructure
- [x] **Kong API Gateway** (ports 8000, 8001) — db-less declarative mode
- [x] **NGINX** (port 3000) — reverse proxy, SSL termination
- [x] **FlareSolverr** (port 8191) — Cloudflare bypass for parsers
- [x] **Coturn TURN** (port 3478) — WebRTC NAT traversal
- [x] **MCP Server** (port 3333) — AI assistant tool server
- [x] **Media Server / SFU** (port 8088, UDP 40000-40099) — Mediasoup WebRTC

## High Availability (docker-compose.ha.yml)

- [x] **PostgreSQL replication**: `docker-compose.ha.yml` — postgres-replica via `pg_basebackup` + `wal_level=replica` on primary
- [x] **Redis Sentinel**: `docker-compose.ha.yml` — redis-replica + 3 sentinel nodes (quorum 2)
- [x] **ScyllaDB multi-node**: `docker-compose.ha.yml` — scylla-node2 with `--seeds=scylla`
- [x] **MinIO distributed**: `docker-compose.ha.yml` — 4 nodes (minio-node1..4) in erasure-code mode
- [x] **Backup strategy**: `scripts/backup.sh` — `backups/{timestamp}/` with `postgres_all.sql.gz` (pg_dumpall), `redis_dump.rdb` (BGSAVE), `minio_videos/` (mc mirror), `scylla_snapshot.tar.gz` (nodetool snapshot) + `manifest.json`. `scripts/restore.sh` — restore with confirmation. Run: `./scripts/backup.sh [dir]`

## Service Port Map

| Port | Service |
|------|---------|
| 3000 | Frontend (NGINX) |
| 3001 | Grafana |
| 3100 | Loki |
| 3333 | MCP Server |
| 3478 | TURN (Coturn) |
| 4222 | NATS |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 8000 | Kong Gateway |
| 8001 | Kong Admin |
| 8081 | Auth Service |
| 8082 | User Service |
| 8083 | Room Service |
| 8084 | Video Service |
| 8085 | WS Gateway |
| 8086 | Sync Service |
| 8087 | Chat Service |
| 8088 | Media Server (SFU) |
| 8089 | Parser Service |
| 8191 | FlareSolverr |
| 9000 | MinIO S3 API |
| 9001 | MinIO Console |
| 9042 | ScyllaDB |
| 9090 | Prometheus |
| 9093 | Alertmanager |
| 9100 | Node Exporter |
| 9121 | Redis Exporter |
| 9187 | PostgreSQL Exporter |
| 16686 | Jaeger |
| 40000-40099 | Media RTC UDP |

## Related Features

- [Auth](./FEATURE_auth.md) — PostgreSQL users, Redis DB 0 (sessions)
- [Rooms](./FEATURE_rooms.md) — PostgreSQL rooms/room_members/invitations
- [Chat](./FEATURE_chat.md) — ScyllaDB (message history), Redis DB 3 (rate limit)
- [Sync](./FEATURE_sync.md) — Redis DB 2 (sync state), NATS (events)
- [Transcoder](./FEATURE_transcoder.md) — MinIO (videos), Redis DB 4 (job queue)
- [WS Gateway](./FEATURE_ws_gateway.md) — Redis DB 1 (pub/sub for WS scaling)
- [Voice/RTC](./FEATURE_voice_rtc.md) — Coturn TURN server
- [Monitoring](./FEATURE_monitoring.md) — exporters: node/redis/postgres → Prometheus
- [Proxy Mode](./FEATURE_proxy_mode.md) — FlareSolverr container (port 8191) for Cloudflare bypass
- [Video Queue](./FEATURE_video_queue.md) — MinIO buckets videos/thumbnails, Redis DB 0 (video metadata cache)
- [File Manager](./FEATURE_file_manager.md) — File Manager API uses MinIO bucket `videos`
- [API Gateway](./FEATURE_api_gateway.md) — Kong and NGINX deployed as docker-compose services
- [Admin](./FEATURE_admin.md) — Admin panel displays Docker container status
- [MCP](./FEATURE_mcp.md) — project-mcp accesses Docker API via unix socket

## Related Files

- `docker-compose.yml` — all services
- `docker-compose.ha.yml` — HA overlay (postgres-replica, redis sentinel, scylla-node2, minio x4)
- `init/postgres/*.sql` — DB schema
- `init/scylla/01_chat.cql` — ScyllaDB schema
- `config/` — configs for all services

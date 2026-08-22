# SyncWatch Platform

Real-time video synchronization platform for watching videos together with friends. Supports YouTube, local files, anime sites (animego, Kodik), and custom URLs — all synchronized across all participants.

## Features

- **Video Sync** — CRDT-based synchronization (play/pause/seek) with sub-100ms precision
- **Voice Chat** — WebRTC + Mediasoup SFU, screen sharing
- **Text Chat** — Real-time chat with ScyllaDB-backed history
- **Multi-Source** — YouTube, direct URLs, anime parsers (animego, Kodik, Aniboom)
- **Server Proxy** — Built-in Cloudflare bypass via FlareSolverr
- **Admin Panel** — User and room management
- **Desktop App** — Windows Electron client (90% complete)
- **PWA** — Install as progressive web app

## Quick Start

### Prerequisites
- Docker + Docker Compose
- 8GB+ RAM

### Launch

```bash
# Windows
start.bat

# Linux/macOS
./start.sh

# Or manually
docker compose up -d --build
```

Open: https://localhost:8443

### Stop

```bash
docker compose down
```

## Architecture

```
Client → NGINX (3000) → Kong Gateway (8000) → Go Microservices (8081-8087)
                         ↕
                    WS Gateway (8085) → NATS → Services
```

**9 microservices**: auth, user, room, video, sync, chat, ws-gateway (Go), parser (Python), media (Node.js)

**Infrastructure**: PostgreSQL, Redis, ScyllaDB, MinIO, NATS, Prometheus, Grafana, Jaeger

Full port map: [docs/FEATURE_infra.md](docs/FEATURE_infra.md)

## Documentation

- [docs/index.md](docs/index.md) — Platform overview
- [docs/featuremap.md](docs/featuremap.md) — Feature tracking
- [docs/FEATURE_infra.md](docs/FEATURE_infra.md) — Infrastructure details
- [documentation.md](documentation.md) — Docs contribution guide

## Testing

```bash
# Integration health check (8/8 services)
python tests/integration/health_check.py

# Full integration test suite (47/53 tests pass)
docker compose --profile test up --build --abort-on-container-exit test-work
```

**Known issues**: WebRTC voice relay, stress-recovery under rapid reconnections — see [docs/featuremap.md](docs/featuremap.md).

## HA Mode

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d
```

Adds PostgreSQL replica, Redis Sentinel, ScyllaDB multi-node, MinIO distributed.

## Backup

```bash
./scripts/backup.sh
./scripts/restore.sh
```

## License

MIT

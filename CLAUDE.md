# SyncWatch Platform

Real-time video synchronization platform with voice chat and multi-source video support.

## Architecture

```
Client (React) → NGINX → Kong API GW → Go Microservices
                             │
                             └── WS Gateway → NATS → Services
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React (Vite) |
| API Gateway | Kong (db-less, declarative) |
| Reverse Proxy | NGINX |
| Microservices | Go 1.22 (8 services), Python/FastAPI (parser), Node.js (media) |
| Message Broker | NATS + JetStream |
| Primary DB | PostgreSQL 16 |
| Cache / Pub-Sub | Redis 7 |
| Chat History | ScyllaDB 5.4 |
| Object Storage | MinIO (S3-compatible) |
| WebRTC SFU | Mediasoup |
| Monitoring | Prometheus, Grafana, Jaeger, Loki |

## Services

| Service | Port | Language | Description |
|---------|------|----------|-------------|
| auth-service | 8081 | Go | JWT auth, user management, email verification |
| user-service | 8082 | Go | User profiles, avatar upload |
| room-service | 8083 | Go | Room CRUD, invitations, member management |
| video-service | 8084 | Go | Video queue, proxy mode, YouTube/Anime metadata |
| ws-gateway | 8085 | Go | Central WebSocket server, auth, connection routing |
| sync-service | 8086 | Go | CRDT video synchronization engine |
| chat-service | 8087 | Go | Real-time chat with ScyllaDB history |
| media-server | 8088 | Node.js | WebRTC SFU (mediasoup), voice chat |
| parser-service | 8089 | Python | Anime site parser (animego, Kodik) via FlareSolverr |
| transcoder | — | Go | FFmpeg video transcoding (NATS worker) |

## Infrastructure

| Component | Port |
|-----------|------|
| PostgreSQL | 5432 |
| Redis | 6379 |
| ScyllaDB | 9042 |
| NATS | 4222 (client), 8222 (monitoring) |
| MinIO | 9000 (API), 9001 (Console) |
| FlareSolverr | 8191 |
| Kong Admin | 8001 |
| Prometheus | 9090 |
| Grafana | 3001 |
| Jaeger | 16686 |
| MCP Server | 3333 |

## Quick Start

```bash
# Windows
start.bat

# Linux/macOS
./start.sh
```

Or manually:
```bash
docker compose up -d --build
```

Frontend: https://localhost:8443
API: http://localhost:8000

## Key Commands

```bash
# View logs
docker compose logs -f [service]

# Stop everything
docker compose down

# Run integration health check
python tests/integration/health_check.py

# HA mode
docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d

# Backup
./scripts/backup.sh
```

## Project Structure

```
SyncWatch-main/
├── services/       # Microservices (Go + Python + Node.js)
├── frontend/       # React SPA
├── config/         # Kong, NGINX, Prometheus, Grafana configs
├── init/           # DB init scripts (PostgreSQL, ScyllaDB)
├── docs/           # Feature documentation
├── scripts/        # backup.sh, restore.sh
├── tests/          # Integration tests
├── desktop/        # Electron desktop app (90% complete)
├── mcp-servers/    # MCP tools for AI assistants
├── archive/        # Archived old code
└── todo/           # Original reference plan
```

## Documentation

- [docs/index.md](docs/index.md) — Platform overview (Russian)
- [docs/featuremap.md](docs/featuremap.md) — Feature progress tracking
- [docs/FEATURE_infra.md](docs/FEATURE_infra.md) — Infrastructure details
- [docs/FEATURE_proxy_mode.md](docs/FEATURE_proxy_mode.md) — Server Proxy Mode spec
- [docs/Refactoring_Plan_SyncWatch.md](docs/Refactoring_Plan_SyncWatch.md) — Refactoring roadmap

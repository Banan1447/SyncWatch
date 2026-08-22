#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# WatchSync Platform — Linux startup script
# Usage: ./start.sh [--build] [--clean]
#   --build   Force rebuild of all Docker images
#   --clean   Remove all volumes and start fresh (WARNING: deletes all data)
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_FLAG=""
CLEAN=false

for arg in "$@"; do
  case $arg in
    --build) BUILD_FLAG="--build" ;;
    --clean) CLEAN=true ;;
  esac
done

# =============================================================================
# 1. Check prerequisites
# =============================================================================
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1    || die "Docker is not installed. Install from https://docs.docker.com/engine/install/"
command -v go >/dev/null 2>&1        || die "Go is not installed. Install from https://go.dev/dl/"

# Docker Compose v2 (plugin)
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Docker Compose not found. Install: https://docs.docker.com/compose/install/"
fi

ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"
ok "Go $(go version | grep -oP 'go\d+\.\d+\.\d+')"
ok "Compose: $COMPOSE"

# =============================================================================
# 2. Create .env if missing
# =============================================================================
if [ ! -f .env ]; then
  warn ".env not found — creating from .env.example"
  cp .env.example .env

  # Auto-detect local IP
  LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
  sed -i "s/^EXTERNAL_IP=.*/EXTERNAL_IP=${LOCAL_IP}/" .env

  warn "Review .env and set DB_PASSWORD, JWT_SECRET, MINIO_PASSWORD before production use"
  info "Using EXTERNAL_IP=${LOCAL_IP}"
fi

# =============================================================================
# 3. Optional clean
# =============================================================================
if [ "$CLEAN" = true ]; then
  warn "Clean mode: removing all containers and volumes..."
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
  ok "Clean done"
fi

# =============================================================================
# 4. Generate go.sum for all services
# =============================================================================
info "Running go mod tidy for all Go services..."

SERVICES=(ws-gateway sync auth room user video chat transcoder)

for svc in "${SERVICES[@]}"; do
  dir="services/$svc"
  if [ -f "$dir/go.mod" ]; then
    echo -n "  $svc... "
    (cd "$dir" && go mod tidy 2>/dev/null) && echo -e "${GREEN}OK${NC}" || echo -e "${YELLOW}WARN (check manually)${NC}"
  fi
done

# npm install for media service (Node.js)
if command -v node >/dev/null 2>&1; then
  if [ -f "services/media/package.json" ] && [ ! -d "services/media/node_modules" ]; then
    info "Installing Node.js deps for media service..."
    (cd services/media && npm install --production 2>/dev/null) && ok "media deps OK" || warn "media deps WARN (will be installed in Docker)"
  fi
fi

# Sync Kong JWT secret with .env
if [ -f .env ]; then
  JWT_SECRET_VAL=$(grep '^JWT_SECRET=' .env | cut -d= -f2- | tr -d '"')
  if [ -n "$JWT_SECRET_VAL" ] && [ -f config/kong/kong.yml ]; then
    sed -i "s/secret: watchsync-jwt-secret-change-in-production-32c/secret: ${JWT_SECRET_VAL}/" config/kong/kong.yml 2>/dev/null || true
  fi
fi

# =============================================================================
# 5. Start infrastructure (databases + message broker)
# =============================================================================
info "Starting infrastructure (postgres, redis, nats, minio)..."
$COMPOSE up -d postgres redis nats minio

info "Waiting for infrastructure to be healthy (up to 60s)..."
for i in $(seq 1 30); do
  HEALTHY=$(docker inspect --format='{{.State.Health.Status}}' watchsync-postgres 2>/dev/null || echo "none")
  REDIS_H=$(docker inspect --format='{{.State.Health.Status}}' watchsync-redis    2>/dev/null || echo "none")
  NATS_H=$( docker inspect --format='{{.State.Health.Status}}' watchsync-nats     2>/dev/null || echo "none")
  MINIO_H=$(docker inspect --format='{{.State.Health.Status}}' watchsync-minio    2>/dev/null || echo "none")

  if [ "$HEALTHY" = "healthy" ] && [ "$REDIS_H" = "healthy" ] && [ "$NATS_H" = "healthy" ] && [ "$MINIO_H" = "healthy" ]; then
    ok "All infrastructure healthy"
    break
  fi

  if [ "$i" = "30" ]; then
    die "Infrastructure did not become healthy in time. Check: $COMPOSE logs postgres redis nats minio"
  fi

  sleep 2
done

# Init MinIO buckets
info "Initialising MinIO buckets..."
$COMPOSE --profile init up -d minio-init
sleep 5

# =============================================================================
# 6. Start ScyllaDB and apply CQL schema
# =============================================================================
info "Starting ScyllaDB..."
$COMPOSE up -d scylla

info "Waiting for ScyllaDB to be ready (up to 120s)..."
for i in $(seq 1 40); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' watchsync-scylla 2>/dev/null || echo "none")
  if [ "$STATUS" = "healthy" ]; then
    ok "ScyllaDB healthy"
    break
  fi
  if [ "$i" = "40" ]; then
    die "ScyllaDB did not become healthy. Check: $COMPOSE logs scylla"
  fi
  sleep 3
done

info "Applying ScyllaDB schema..."
docker exec -i watchsync-scylla cqlsh <<'CQL'
CREATE KEYSPACE IF NOT EXISTS chat
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    AND durable_writes = true;

USE chat;

CREATE TABLE IF NOT EXISTS chat_messages (
    room_id UUID,
    bucket TIMESTAMP,
    message_id TIMEUUID,
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    content TEXT,
    message_type TEXT,
    metadata MAP<TEXT, TEXT>,
    PRIMARY KEY ((room_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 2592000;

CREATE TABLE IF NOT EXISTS chat_read_receipts (
    room_id UUID,
    user_id UUID,
    last_read_message_id TIMEUUID,
    last_read_at TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
);
CQL
ok "ScyllaDB schema applied"

# =============================================================================
# 7. Build and start all application services
# =============================================================================
info "Building and starting application services..."
$COMPOSE up -d $BUILD_FLAG \
  auth-service \
  user-service \
  room-service \
  video-service \
  ws-gateway \
  sync-service \
  chat-service \
  transcoder \
  media-server \
  parser-service \
  flaresolverr \
  nginx \
  frontend \
  kong \
  prometheus \
  grafana

# =============================================================================
# 8. Health check — wait for all services
# =============================================================================
info "Waiting for services to be healthy (up to 60s)..."

PORTS=(8081 8082 8083 8084 8085 8086 8087 8088 8089)
NAMES=(auth user room video ws-gateway sync chat media parser)

sleep 10

ALL_OK=true
for idx in "${!PORTS[@]}"; do
  port="${PORTS[$idx]}"
  name="${NAMES[$idx]}"
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    ok "  $name (:$port)"
  else
    warn "  $name (:$port) — HTTP $STATUS (may still be starting)"
    ALL_OK=false
  fi
done

FRONTEND_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost:8443 2>/dev/null || echo "000")
[ "$FRONTEND_STATUS" = "200" ] && ok "  frontend (:8443)" || warn "  frontend (:8443) — HTTP $FRONTEND_STATUS"

# =============================================================================
# 9. Summary
# =============================================================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  WatchSync Platform is running!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}    https://localhost:8443"
echo -e "  ${CYAN}API Gateway:${NC} http://localhost:8000"
echo -e "  ${CYAN}WebSocket:${NC}   ws://localhost:8085/ws"
echo -e "  ${CYAN}MinIO:${NC}       http://localhost:9001  (minioadmin/minioadmin)"
echo -e "  ${CYAN}Grafana:${NC}     http://localhost:3001  (admin/admin)"
echo -e "  ${CYAN}Prometheus:${NC}  http://localhost:9090"
echo -e "  ${CYAN}Jaeger:${NC}      http://localhost:16686"
echo ""
echo -e "  Logs:  ${YELLOW}$COMPOSE logs -f <service-name>${NC}"
echo -e "  Stop:  ${YELLOW}$COMPOSE down${NC}"
echo ""

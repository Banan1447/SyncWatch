#!/bin/bash
# WatchSync Platform — Backup Script
# Usage: ./scripts/backup.sh [backup_dir]
# Creates timestamped backup of all persistent data stores.

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_ROOT="${1:-./backups}"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"
echo "[backup] Starting backup → $BACKUP_DIR"

# ── PostgreSQL (users, rooms) ─────────────────────────────────────────────────
echo "[backup] PostgreSQL..."
docker exec watchsync-postgres pg_dumpall -U watchsync \
  > "$BACKUP_DIR/postgres_all.sql"
gzip "$BACKUP_DIR/postgres_all.sql"
echo "[backup] PostgreSQL done → postgres_all.sql.gz"

# ── Redis (sessions, pub/sub) ──────────────────────────────────────────────────
echo "[backup] Redis..."
docker exec watchsync-redis redis-cli BGSAVE > /dev/null
sleep 2  # wait for BGSAVE to finish
docker cp watchsync-redis:/data/dump.rdb "$BACKUP_DIR/redis_dump.rdb"
echo "[backup] Redis done → redis_dump.rdb"

# ── MinIO (videos, subtitles, chat-files) ────────────────────────────────────
echo "[backup] MinIO..."
MINIO_ALIAS="backup_minio_$$"
docker run --rm --network watchsync_backend \
  -v "$BACKUP_DIR:/backup" \
  minio/mc alias set "$MINIO_ALIAS" http://minio:9000 \
    "${MINIO_ROOT_USER:-minioadmin}" "${MINIO_ROOT_PASSWORD:-minioadmin}" > /dev/null 2>&1 || true
docker run --rm --network watchsync_backend \
  -v "$(realpath "$BACKUP_DIR"):/backup" \
  minio/mc mirror "$MINIO_ALIAS/videos" /backup/minio_videos --overwrite > /dev/null 2>&1 || \
  echo "[backup] MinIO: skipping (minio/mc mirror failed, check MINIO_ROOT_USER/PASSWORD)"
echo "[backup] MinIO done → minio_videos/"

# ── ScyllaDB (chat messages) ──────────────────────────────────────────────────
echo "[backup] ScyllaDB..."
SCYLLA_SNAPSHOT="snapshot_$TIMESTAMP"
docker exec watchsync-scylla nodetool snapshot -t "$SCYLLA_SNAPSHOT" 2>/dev/null || \
  echo "[backup] ScyllaDB: nodetool snapshot failed (Scylla may not be running)"
# Copy snapshot files out
SCYLLA_DATA=$(docker exec watchsync-scylla find /var/lib/scylla/data -name "snapshots" -type d 2>/dev/null | head -1)
if [ -n "$SCYLLA_DATA" ]; then
  docker exec watchsync-scylla tar -czf "/tmp/scylla_snapshot_$TIMESTAMP.tar.gz" \
    -C /var/lib/scylla/data . --include="*/snapshots/$SCYLLA_SNAPSHOT/*" 2>/dev/null || true
  docker cp "watchsync-scylla:/tmp/scylla_snapshot_$TIMESTAMP.tar.gz" \
    "$BACKUP_DIR/scylla_snapshot.tar.gz" 2>/dev/null || \
    echo "[backup] ScyllaDB: copy failed"
fi
echo "[backup] ScyllaDB done"

# ── Manifest ──────────────────────────────────────────────────────────────────
cat > "$BACKUP_DIR/manifest.json" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "platform": "WatchSync",
  "contents": ["postgres_all.sql.gz", "redis_dump.rdb", "minio_videos/", "scylla_snapshot.tar.gz"],
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "[backup] ✓ Complete: $BACKUP_DIR"
du -sh "$BACKUP_DIR" 2>/dev/null || true

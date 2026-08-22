#!/bin/bash
# WatchSync Platform — Restore Script
# Usage: ./scripts/restore.sh <backup_dir>
# Restores from a backup created by backup.sh.

set -euo pipefail

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Usage: $0 <backup_dir>"
  echo "Available backups:"
  ls -1t ./backups/ 2>/dev/null | head -10 | sed 's/^/  /'
  exit 1
fi

echo "[restore] Restoring from $BACKUP_DIR"
echo "[restore] WARNING: This will overwrite existing data. Press Ctrl+C to abort. Waiting 5s..."
sleep 5

# ── PostgreSQL ─────────────────────────────────────────────────────────────────
if [ -f "$BACKUP_DIR/postgres_all.sql.gz" ]; then
  echo "[restore] PostgreSQL..."
  zcat "$BACKUP_DIR/postgres_all.sql.gz" | \
    docker exec -i watchsync-postgres psql -U watchsync postgres
  echo "[restore] PostgreSQL done"
fi

# ── Redis ─────────────────────────────────────────────────────────────────────
if [ -f "$BACKUP_DIR/redis_dump.rdb" ]; then
  echo "[restore] Redis..."
  docker exec watchsync-redis redis-cli FLUSHALL > /dev/null
  docker cp "$BACKUP_DIR/redis_dump.rdb" watchsync-redis:/data/dump.rdb
  docker restart watchsync-redis
  echo "[restore] Redis done (restarted)"
fi

# ── ScyllaDB ──────────────────────────────────────────────────────────────────
if [ -f "$BACKUP_DIR/scylla_snapshot.tar.gz" ]; then
  echo "[restore] ScyllaDB..."
  docker cp "$BACKUP_DIR/scylla_snapshot.tar.gz" watchsync-scylla:/tmp/scylla_restore.tar.gz
  docker exec watchsync-scylla sh -c \
    "cd /var/lib/scylla/data && tar -xzf /tmp/scylla_restore.tar.gz --strip-components=5 2>/dev/null || true"
  echo "[restore] ScyllaDB: manual sstableloader may be required for full restore"
fi

echo ""
echo "[restore] ✓ Restore complete from $BACKUP_DIR"

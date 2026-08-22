@echo off
setlocal enabledelayedexpansion
title WatchSync Platform — Windows Startup

echo.
echo ============================================================
echo   WatchSync Platform — Windows Start Script
echo ============================================================
echo.

:: ─── Check Docker ───────────────────────────────────────────────────────────
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not running.
    echo         Install from: https://docs.docker.com/desktop/install/windows/
    pause & exit /b 1
)

:: ─── Check Compose ──────────────────────────────────────────────────────────
docker compose version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Compose not found. Update Docker Desktop.
    pause & exit /b 1
)

:: ─── Check Go ───────────────────────────────────────────────────────────────
go version >nul 2>&1
if errorlevel 1 (
    echo [WARN] Go not found — skipping go mod tidy.
    echo        Install from: https://go.dev/dl/
    set SKIP_GO=1
) else (
    set SKIP_GO=0
)

:: ─── Create .env if missing ─────────────────────────────────────────────────
if not exist .env (
    echo [INFO] .env not found — creating from .env.example
    copy .env.example .env >nul
    echo [WARN] Edit .env and set DB_PASSWORD, JWT_SECRET, MINIO_PASSWORD, EXTERNAL_IP
)

:: ─── go mod tidy for all Go services ────────────────────────────────────────
if "!SKIP_GO!"=="0" (
    echo [INFO] Running go mod tidy for all Go services...
    for %%S in (ws-gateway sync auth room user video chat transcoder) do (
        if exist services\%%S\go.mod (
            echo   %%S...
            pushd services\%%S
            go mod tidy 2>nul
            popd
        )
    )
    echo [OK] go mod tidy done
)

:: ─── npm install for media service ──────────────────────────────────────────
node --version >nul 2>&1
if not errorlevel 1 (
    if exist services\media\package.json (
        if not exist services\media\node_modules (
            echo [INFO] Installing Node.js deps for media service...
            pushd services\media
            npm install --production 2>nul
            popd
        )
    )
)

:: ─── Sync Kong JWT secret ────────────────────────────────────────────────────
echo [INFO] Note: ensure JWT_SECRET in .env matches 'secret' in config/kong/kong.yml

:: ─── Start infrastructure ───────────────────────────────────────────────────
echo.
echo [INFO] Starting infrastructure (postgres, redis, nats, minio)...
docker compose up -d postgres redis nats minio

echo [INFO] Waiting 30s for infrastructure...
timeout /t 30 /nobreak >nul

:: ─── Start ScyllaDB + auto-init ─────────────────────────────────────────────
echo [INFO] Starting ScyllaDB...
docker compose up -d scylla

echo [INFO] Waiting 90s for ScyllaDB to be ready...
timeout /t 90 /nobreak >nul

echo [INFO] Applying ScyllaDB schema (auto-init container)...
docker compose --profile init up scylla-init
echo [OK] ScyllaDB schema applied

:: ─── Build and start all services ───────────────────────────────────────────
echo.
echo [INFO] Building and starting all application services...
docker compose up -d --build ^
  auth-service ^
  user-service ^
  room-service ^
  video-service ^
  ws-gateway ^
  sync-service ^
  chat-service ^
  transcoder ^
  media-server ^
  parser-service ^
  flaresolverr ^
  nginx ^
  frontend ^
  kong ^
  prometheus ^
  grafana

echo.
echo [INFO] Waiting 15s for services to start...
timeout /t 15 /nobreak >nul

:: ─── Health check ────────────────────────────────────────────────────────────
echo.
echo [INFO] Checking service health...
for %%P in (8081 8082 8083 8084 8085 8086 8087 8088 8089) do (
    curl -s -o nul -w "  :%%P HTTP %%{http_code}\n" "http://localhost:%%P/health" 2>nul || echo   :%%P not responding yet
)

:: ─── Summary ────────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   WatchSync Platform is running!
echo ============================================================
echo.
echo   Frontend:    https://localhost:8443
echo   API Gateway: http://localhost:8000
echo   WebSocket:   ws://localhost:8085/ws
echo   Media SFU:   http://localhost:8088
echo   MinIO:       http://localhost:9001  (minioadmin/minioadmin)
echo   Grafana:     http://localhost:3001  (admin/admin)
echo   Prometheus:  http://localhost:9090
echo   Jaeger:      http://localhost:16686
echo.
echo   Logs:  docker compose logs -f [service]
echo   Stop:  docker compose down
echo.
pause

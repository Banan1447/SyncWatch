# WatchSync Platform

Платформа для совместного просмотра видео с полной синхронизацией, голосовым чатом и AI-функциями.

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                         WATCHSYNC PLATFORM                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │   Web App   │  │   iOS App   │  │ Android App │  │ Desktop │ │
│  │   (React)   │  │   (Swift)   │  │  (Kotlin)   │  │(Electron│ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────┬────┘ │
│         └─────────────────┴─────────────────┴──────────────┘     │
│                                    │                             │
│                           ┌────────▼────────┐                    │
│                           │  NGINX/Kong LB  │                    │
│                           └────────┬────────┘                    │
│                                    │                             │
│  ┌─────────────────────────────────┼──────────────────────────┐ │
│  │                                 │                          │ │
│  │  ┌──────────────┐  ┌───────────▼──────────┐  ┌──────────┐ │ │
│  │  │  Auth        │  │  WebSocket Gateway   │  │  Media   │ │ │
│  │  │  Service     │  │  (Go)                │  │  Server  │ │ │
│  │  └──────────────┘  └───────────┬──────────┘  └──────────┘ │ │
│  │  ┌──────────────┐  ┌───────────▼──────────┐  ┌──────────┐ │ │
│  │  │  Room        │  │  Sync Service        │  │  Chat    │ │ │
│  │  │  Service     │  │  (CRDT-based)        │  │  Service │ │ │
│  │  └──────────────┘  └──────────────────────┘  └──────────┘ │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    DATA LAYER                               │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │PostgreSQL│  │ ScyllaDB │  │  Redis   │  │   MinIO    │  │ │
│  │  │ (Users)  │  │  (Chat)  │  │ (Cache)  │  │  (Videos)  │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Быстрый старт

### Требования

- Docker 24.0+
- Docker Compose 2.20+
- 8GB+ RAM
- 4 CPU cores

### Установка

1. Клонируйте репозиторий:
```bash
git clone https://github.com/yourusername/watchsync.git
cd watchsync
```

2. Создайте файл конфигурации:
```bash
cp .env.example .env
# Отредактируйте .env файл
```

3. Запустите сервисы:
```bash
docker-compose up -d
```

4. Проверьте статус:
```bash
docker-compose ps
```

### Доступ к сервисам

| Сервис | URL | Описание |
|--------|-----|----------|
| Frontend | http://localhost:3000 | Веб-приложение |
| API Gateway | http://localhost:8000 | REST API |
| WebSocket | ws://localhost:8085/ws | Real-time соединения |
| Grafana | http://localhost:3001 | Мониторинг |
| Prometheus | http://localhost:9090 | Метрики |
| MinIO Console | http://localhost:9001 | S3 хранилище |

## Разработка

### Структура проекта

```
watchsync/
├── config/                 # Конфигурационные файлы
│   ├── kong/              # Kong API Gateway
│   ├── nginx/             # NGINX
│   ├── coturn/            # TURN server
│   ├── prometheus/        # Monitoring
│   └── grafana/           # Dashboards
├── services/              # Микросервисы
│   ├── auth/              # Authentication
│   ├── user/              # User management
│   ├── room/              # Room management
│   ├── video/             # Video service
│   ├── chat/              # Chat service
│   ├── sync/              # Synchronization engine
│   ├── ws-gateway/        # WebSocket gateway
│   ├── media/             # WebRTC media server
│   └── ml/                # AI/ML service
├── frontend/              # React приложение
├── docker-compose.yml     # Docker конфигурация
└── README.md
```

### Локальная разработка

1. Запустите инфраструктуру:
```bash
docker-compose up -d postgres redis scylla minio nats
```

2. Запустите сервисы локально:
```bash
cd services/ws-gateway
go run main.go
```

3. Запустите фронтенд:
```bash
cd frontend
npm install
npm start
```

## API Documentation

### WebSocket Protocol

```javascript
// Подключение к комнате
{
  "type": "join_room",
  "payload": {
    "room_id": "room-uuid",
    "user_id": "user-uuid",
    "token": "jwt-token"
  }
}

// Действие с видео
{
  "type": "video_action",
  "payload": {
    "action": "play|pause|seek|rate_change",
    "time": 120.5,
    "rate": 1.0,
    "version": 1234567890
  }
}

// Сообщение в чат
{
  "type": "chat_message",
  "payload": {
    "content": "Hello!",
    "type": "text"
  }
}
```

### REST API

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/auth/me

POST   /api/v1/rooms
GET    /api/v1/rooms/:id
PATCH  /api/v1/rooms/:id
DELETE /api/v1/rooms/:id
POST   /api/v1/rooms/:id/join

GET    /api/v1/rooms/:id/messages
POST   /api/v1/rooms/:id/queue
```

## Мониторинг

### Метрики

- **WebSocket Connections**: Активные соединения
- **Message Rate**: Сообщений/сек
- **Sync Latency**: Задержка синхронизации
- **Room Count**: Активные комнаты
- **Video Buffer Health**: Здоровье буфера видео

### Алерты

- CPU > 80% в течение 5 минут
- Memory > 85% в течение 5 минут
- WebSocket disconnect rate > 10%
- Sync latency > 500ms

## Масштабирование

### Горизонтальное масштабирование

```bash
# Масштабирование WebSocket Gateway
docker-compose up -d --scale ws-gateway=5

# Или через Docker Swarm
docker stack deploy -c docker-compose.yml watchsync
```

### Kubernetes

```bash
kubectl apply -f k8s/
kubectl scale deployment ws-gateway --replicas=10
```

## Troubleshooting

### Проблемы с WebSocket

```bash
# Проверка соединения
wscat -c ws://localhost:8085/ws

# Просмотр логов
docker-compose logs -f ws-gateway
```

### Проблемы с синхронизацией

```bash
# Проверка Redis
docker-compose exec redis redis-cli ping

# Просмотр состояния комнаты
docker-compose exec redis redis-cli GET "room:room-id:video_state"
```

### Проблемы с WebRTC

```bash
# Проверка TURN сервера
# Используйте: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
# TURN URL: turn:your-ip:3478
```

## Лицензия

MIT License

## Контакты

- Email: support@watchsync.app
- Discord: https://discord.gg/watchsync
- Twitter: @watchsync

---

## Документация

- [index](../docs/index.md) — центральный хаб документации
- [featuremap](../docs/featuremap.md) — статус разработки (Kanban)
- [FEATURE_auth](../docs/FEATURE_auth.md) — аутентификация и JWT
- [FEATURE_rooms](../docs/FEATURE_rooms.md) — управление комнатами
- [FEATURE_sync](../docs/FEATURE_sync.md) — CRDT-синхронизация видео
- [FEATURE_ws_gateway](../docs/FEATURE_ws_gateway.md) — WebSocket Gateway
- [FEATURE_chat](../docs/FEATURE_chat.md) — чат (ScyllaDB)
- [FEATURE_video_queue](../docs/FEATURE_video_queue.md) — очередь видео (MinIO)
- [FEATURE_transcoder](../docs/FEATURE_transcoder.md) — транскодирование (FFmpeg)
- [FEATURE_voice_rtc](../docs/FEATURE_voice_rtc.md) — голос (Mediasoup SFU)
- [FEATURE_frontend](../docs/FEATURE_frontend.md) — React SPA
- [FEATURE_api_gateway](../docs/FEATURE_api_gateway.md) — Kong + NGINX
- [FEATURE_infra](../docs/FEATURE_infra.md) — инфраструктура Docker
- [FEATURE_monitoring](../docs/FEATURE_monitoring.md) — Prometheus + Grafana + Jaeger
- [FEATURE_proxy_mode](../docs/FEATURE_proxy_mode.md) — Server Proxy Mode

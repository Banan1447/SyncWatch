---
title: WatchSync Platform — Технический план
status: archived
note: Исходный план разработки. Актуальная документация в docs/
---

> Архивный документ. Актуальная документация: [index](../docs/index.md) | [featuremap](../docs/featuremap.md)

# План разработки платформы совместного просмотра видео
## Полный технический документ с архитектурой, стеком и стратегией

---

# ЧАСТЬ 1: АНАЛИЗ И СТРАТЕГИЯ

## 1.1 Анализ конкурентов

### Discord (для сравнения)
**Архитектура:**
- **Бэкенд:** Elixir/Erlang (BEAM VM) - выбор для масштабирования real-time
- **База данных:** ScyllaDB (миграция с Cassandra в 2020) - 15 млн пользователей на один сервер
- **WebSocket Gateway:** Кастомная реализация на Elixir
- **Медиа:** WebRTC для голоса/видео, SFU для стримов
- **Инфраструктура:** Микросервисы, Kubernetes, глобальная CDN

**Преимущества:**
- Невероятная масштабируемость (140+ млн пользователей)
- Субсекундная задержка сообщений
- Надежность 99.99%

**Недостатки:**
- Сложность инфраструктуры
- Высокие требования к DevOps
- Не специализирован под видео-синхронизацию

### Watch2Gether
**Архитектура:**
- **Фронтенд:** React + TypeScript
- **Синхронизация:** Socket.io (WebSocket с fallback)
- **Видео:** Встроенные плееры (YouTube, Vimeo API)
- **Бэкенд:** Node.js + Express

**Преимущества:**
- Простота использования
- Поддержка множества источников видео
- Не требует регистрации

**Недостатки:**
- Ограниченная масштабируемость
- Зависимость от внешних API
- Нет собственного стриминг-сервера

### Teleparty (Netflix Party)
**Архитектура:**
- Браузерное расширение
- WebSocket для синхронизации
- Интеграция с Netflix API

**Преимущества:**
- Простая интеграция со стриминговыми сервисами
- Низкий порог входа

**Недостатки:**
- Ограничен функционал
- Зависимость от платформ
- Нет голосового чата

---

## 1.2 Выбор технологического стека

### Рекомендуемый стек: **"Hybrid Performance Stack"

#### Бэкенд: Go (Golang)
**Почему Go:**
| Критерий | Go | Node.js | Rust | Elixir |
|----------|-----|---------|------|--------|
| Производительность | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Простота разработки | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| WebSocket производительность | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Экосистема WebRTC | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| Масштабируемость | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Скорость разработки | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |

**Вывод:** Go - оптимальный баланс производительности и скорости разработки. Goroutines обрабатывают миллионы соединений эффективнее Node.js.

#### Real-time коммуникации: WebSocket (нативный) + Redis Pub/Sub
**Почему не Socket.io:**
- Socket.io добавляет 30-40% overhead
- Нативный WebSocket: 44,000 msg/sec vs Socket.io: 27,000 msg/sec
- Полный контроль над протоколом

**Масштабирование:**
```
┌─────────────────┐
│  Load Balancer  │
│   (NGINX/HAProxy)│
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌───▼───┐
│ WS-1  │ │ WS-2  │  ...  │ WS-N  │
│(Go)   │ │(Go)   │       │(Go)   │
└───┬───┘ └───┬───┘       └───┬───┘
    │         │               │
    └─────────┼───────────────┘
              │
        ┌─────▼─────┐
        │   Redis   │
        │  Cluster  │
        └───────────┘
```

#### WebRTC Media Server: Mediasoup (SFU)
**Почему Mediasoup:**
- Современная C++ реализация с Node.js API
- SFU архитектура: один поток → многим получателям
- Поддержка simulcast (адаптивное качество)
- Низкая задержка (< 500ms)
- Поддержка 1000+ зрителей на один сервер

**Альтернативы:**
- **Janus:** Старше, на C, сложнее в разработке
- **Jitsi:** Полное решение, менее гибкое
- **Pion:** На Go, быстрорастущий, но менее зрелый

#### Базы данных

**Основная БД: PostgreSQL**
- Пользователи, комнаты, метаданные
- ACID транзакции
- Отличная экосистема

**Real-time/Chat: ScyllaDB**
- Замена Cassandra (как у Discord)
- P99 latency: 5-15ms (против 40-125ms у Cassandra)
- 10x меньше нодов для той же нагрузки
- Идеальна для сообщений, истории чата

**Кэш/Сессии: Redis Cluster**
- Pub/Sub для масштабирования WebSocket
- Хранение сессий пользователей
- Rate limiting

**Аналитика: TimescaleDB**
- Time-series данные
- Метрики просмотров, синхронизации
- PostgreSQL-совместимая

#### Хранилище видео: MinIO
- S3-compatible API
- Высокая производительность
- Репликация и шардирование
- Стоимость в 10x ниже AWS S3

#### Видео-стриминг: HLS + WebRTC
| Сценарий | Протокол | Задержка |
|----------|----------|----------|
| Локальные файлы | HLS | 2-5 сек |
| YouTube/Twitch | Встроенный API | Зависит от источника |
| Live стримы | WebRTC | < 500ms |
| Screen sharing | WebRTC | < 300ms |

---

## 1.3 Killer Feature: "SyncSense AI"

### Концепция: AI-управляемая синхронизация с предиктивной адаптацией

**Проблема существующих решений:**
- Ручная синхронизация при отставании
- Нет адаптации под сетевые условия
- Статичное качество видео

**SyncSense AI решает:**

1. **Предиктивная буферизация**
   - ML-модель анализирует сетевые условия каждого пользователя
   - Предварительная буферизация перед падением скорости
   - Автоматическая адаптация качества (simulcast)

2. **Smart Sync**
   - Автоматическая корректировка при рассинхронизации > 100ms
   - Плавное "подтягивание" без резких скачков
   - Приоритет аудио над видео (как у WebRTC)

3. **Emotion Sync**
   - AI анализирует реакции пользователей
   - Автоматические метки "смешно", "напряженно", "грустно"
   - Таймкоды для повторного просмотра лучших моментов

4. **Voice Activity Detection**
   - Автоматическое понижение громкости видео когда кто-то говорит
   - Умное подавление эха

5. **Content-Aware Recommendations**
   - AI предлагает что смотреть дальше на основе реакций группы
   - Персонализированные очереди для каждого участника

**Техническая реализация:**
- TensorFlow Lite на клиенте (анализ в реальном времени)
- WebRTC Insertable Streams для обработки видео
- Edge ML на сервере для агрегированных рекомендаций

---

# ЧАСТЬ 2: АРХИТЕКТУРА СИСТЕМЫ

## 2.1 Общая архитектура микросервисов

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              КЛИЕНТЫ                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Web     │  │  iOS     │  │ Android  │  │ Desktop  │  │  TV      │  │
│  │(React)   │  │(Swift)   │  │(Kotlin)  │  │(Electron)│  │(Tizen)   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
└───────┼─────────────┼─────────────┼─────────────┼─────────────┼────────┘
        │             │             │             │             │
        └─────────────┴─────────────┴─────────────┴─────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  CloudFlare CDN   │
                    │  + DDoS Protection│
                    └─────────┬─────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼────────┐  ┌─────────▼─────────┐  ┌───────▼────────┐
│  API Gateway   │  │  WebSocket LB     │  │  Media LB      │
│  (Kong/NGINX)  │  │  (HAProxy)        │  │  (HAProxy)     │
└───────┬────────┘  └─────────┬─────────┘  └───────┬────────┘
        │                     │                     │
        │            ┌────────┴────────┐            │
        │            │                 │            │
┌───────▼────────┐  ┌▼──────────────┐ ┌▼──────────┐│
│  Auth Service  │  │  WS Gateway 1 │ │ WS GW 2   ││
│  (Go/JWT)      │  │  (Go)         │ │ (Go)      ││
└───────┬────────┘  └───────┬───────┘ └─────┬─────┘│
        │                   │               │      │
        │            ┌──────┴──────┐        │      │
        │            │             │        │      │
        │      ┌─────▼─────┐ ┌─────▼─────┐  │      │
        │      │  Redis    │ │  Redis    │  │      │
        │      │  Pub/Sub  │ │  Cluster  │  │      │
        │      └───────────┘ └───────────┘  │      │
        │                                   │      │
┌───────▼────────┐  ┌───────────────────────┴──┐  ┌▼──────────────┐
│  User Service  │  │   Sync Service (Go)      │  │  Media Server │
│  (PostgreSQL)  │  │   - Room management      │  │  (Mediasoup)  │
└───────┬────────┘  │   - State sync           │  └───────┬───────┘
        │           │   - Queue management     │          │
┌───────▼────────┐  └──────────────────────────┘  ┌───────▼───────┐
│  Room Service  │                                 │  TURN Server  │
│  (PostgreSQL)  │  ┌──────────────────────────┐  │  (Coturn)     │
└───────┬────────┘  │   Chat Service (Go)      │  └───────────────┘
        │           │   - ScyllaDB for history │
┌───────▼────────┐  │   - Real-time delivery   │  ┌───────────────┐
│  Video Service │  └──────────────────────────┘  │  MinIO Cluster│
│  (PostgreSQL + │                                 │  (S3 storage) │
│   MinIO)       │  ┌──────────────────────────┐  └───────────────┘
└───────┬────────┘  │   Analytics Service      │
        │           │   (TimescaleDB)          │
┌───────▼────────┐  └──────────────────────────┘
│  AI/ML Service │
│  (Python/TF)   │
└────────────────┘
```

## 2.2 Детальная архитектура синхронизации

### State Machine комнаты

```
┌─────────────────────────────────────────────────────────────┐
│                    ROOM STATE MACHINE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐    join     ┌──────────┐    play     ┌────────┐│
│  │  EMPTY   │────────────▶│  WAITING │────────────▶│PLAYING ││
│  │          │             │ (owner   │             │        ││
│  └──────────┘             │  joined) │             └────┬───┘│
│       ▲                   └──────────┘                  │    │
│       │                        ▲                        │    │
│       │    all leave           │    pause              │    │
│       │                        │                        │    │
│  ┌────┴───┐              ┌─────┴───┐                   │    │
│  │ CLOSED │◀─────────────│ PAUSED  │◀──────────────────┘    │
│  │        │   all leave  │         │                        │
│  └────────┘              └─────────┘                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Алгоритм синхронизации (CRDT-based)

```go
// Структура состояния видео
type VideoState struct {
    RoomID        string    `json:"room_id"`
    CurrentTime   float64   `json:"current_time"`   // Текущая позиция
    PlaybackRate  float64   `json:"playback_rate"`  // Скорость (0.5x - 2x)
    IsPlaying     bool      `json:"is_playing"`
    Timestamp     int64     `json:"timestamp"`      // Время сервера (мс)
    Source        string    `json:"source"`         // Инициатор изменения
    Version       uint64    `json:"version"`        // Lamport timestamp
}

// CRDT Merge функция
func (a *VideoState) Merge(b *VideoState) *VideoState {
    // Выбираем состояние с большей версией
    if b.Version > a.Version {
        return b
    }
    if a.Version > b.Version {
        return a
    }
    // При равных версиях - детерминированный выбор
    if b.Timestamp > a.Timestamp {
        return b
    }
    return a
}
```

### Latency Compensation

```
Клиент A (Нью-Йорк, RTT=50ms)          Сервер (Франкфурт)          Клиент B (Токио, RTT=150ms)
         │                                      │                              │
         │  play @ T=120.5s                     │                              │
         │─────────────────────────────────────▶│                              │
         │                                      │  play @ T=120.5s (+25ms)     │
         │                                      │─────────────────────────────▶│
         │                                      │                              │
         │                                      │  play @ T=120.5s (+75ms)     │
         │◀─────────────────────────────────────│                              │
         │                                      │                              │
         │  ACK @ T=120.525s                    │                              │
         │─────────────────────────────────────▶│                              │
         │                                      │  ACK                         │
         │                                      │─────────────────────────────▶│
```

**Формула компенсации:**
```
adjusted_time = server_time + (client_rtt / 2) + buffer_offset

где:
- client_rtt = round-trip time клиента
- buffer_offset = 50-100ms (буфер для jitter)
```

## 2.3 Модель данных

### PostgreSQL Schema

```sql
-- Пользователи
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(32) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    avatar_url TEXT,
    preferences JSONB DEFAULT '{}',
    subscription_tier VARCHAR(20) DEFAULT 'free',
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP
);

-- Комнаты
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(32) UNIQUE NOT NULL, -- короткий код для приглашения
    owner_id UUID REFERENCES users(id),
    video_source VARCHAR(50), -- 'youtube', 'local', 'upload'
    video_url TEXT,
    video_metadata JSONB,
    settings JSONB DEFAULT '{
        "is_public": false,
        "max_users": 10,
        "allow_chat": true,
        "allow_voice": true,
        "sync_mode": "strict"
    }',
    current_state JSONB, -- текущее состояние видео
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP -- для временных комнат
);

-- Участники комнаты
CREATE TABLE room_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'viewer', -- 'owner', 'moderator', 'viewer'
    permissions JSONB DEFAULT '{}',
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at TIMESTAMP,
    UNIQUE(room_id, user_id)
);

-- Очередь видео
CREATE TABLE video_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id),
    video_source VARCHAR(50) NOT NULL,
    video_url TEXT NOT NULL,
    video_metadata JSONB,
    position INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'playing', 'completed', 'skipped'
    created_at TIMESTAMP DEFAULT NOW()
);

-- Приглашения
CREATE TABLE invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    code VARCHAR(16) UNIQUE NOT NULL,
    expires_at TIMESTAMP,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);
```

### ScyllaDB Schema (Chat)

```sql
-- Сообщения чата
CREATE TABLE chat_messages (
    room_id UUID,
    bucket TIMESTAMP, -- дата для партиционирования
    message_id TIMEUUID,
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    content TEXT,
    message_type TEXT, -- 'text', 'reaction', 'system'
    metadata MAP<TEXT, TEXT>,
    PRIMARY KEY ((room_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Индекс для поиска по пользователю
CREATE INDEX ON chat_messages(user_id);

-- Последние прочитанные сообщения
CREATE TABLE chat_read_receipts (
    room_id UUID,
    user_id UUID,
    last_read_message_id TIMEUUID,
    last_read_at TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
);
```

### Redis Structures

```
# Сессии пользователей
session:{user_id} -> {
    "socket_id": "ws_123",
    "room_id": "room_456",
    "connected_at": 1234567890,
    "ip": "1.2.3.4",
    "user_agent": "..."
}

# Состояние комнаты (TTL: 24h)
room:{room_id}:state -> {
    "video_time": 120.5,
    "is_playing": true,
    "playback_rate": 1.0,
    "last_update": 1234567890,
    "updated_by": "user_123"
}

# Присутствие в комнате
room:{room_id}:presence -> Set {
    "user_123",
    "user_456",
    ...
}

# Rate limiting
ratelimit:{user_id}:{action} -> Counter (TTL: 1min)

# Pub/Sub channels
pubsub:room:{room_id} -> Channel for room events
pubsub:user:{user_id} -> Channel for user notifications
```

---

# ЧАСТЬ 3: МОНЕТИЗАЦИЯ

## 3.1 Модель Freemium

### Free Tier
- До 5 пользователей в комнате
- 720p максимальное качество
- 2 часа на комнату
- Очередь до 10 видео
- Базовый чат
- Реклама (неинтрузивная)

### Premium ($4.99/месяц)
- До 20 пользователей
- 1080p + 4K
- Неограниченное время
- Неограниченная очередь
- Голосовой чат
- Приоритетная синхронизация
- Кастомные эмодзи

### Pro ($9.99/месяц)
- До 100 пользователей
- 4K + HDR
- Screen sharing
- Запись сессий
- API доступ
- White-label опция
- Поддержка 24/7

### Enterprise (от $49/комната/месяц)
- Неограниченно пользователей
- Self-hosted опция
- SSO интеграция
- SLA 99.99%
- Выделенная поддержка
- Кастомная разработка

## 3.2 Дополнительные источники дохода

1. **Virtual Gifts** (как у TikTok)
   - Пользователи покупают подарки для стримера
   - Комиссия платформы 30%

2. **Affiliate Program**
   - Интеграция с Amazon, Netflix, etc.
   - Комиссия за переходы и покупки

3. **Sponsored Rooms**
   - Бренды создают комнаты для премьер
   - Нативная реклама

4. **Tipping**
   - Чаевые создателю комнаты
   - Комиссия 10%

5. **NFT Integration**
   - Эксклюзивные эмодзи и бейджи
   - Коллекционные предметы

## 3.3 Прогноз экономики

```
Метрики (на 100k активных пользователей):
- Конверсия в Premium: 5% = 5,000 × $5 = $25,000/мес
- Конверсия в Pro: 1% = 1,000 × $10 = $10,000/мес
- Enterprise: 10 клиентов × $500 = $5,000/мес
- Virtual Gifts: $15,000/мес
- Реклама: $20,000/мес

Итого: ~$75,000/мес ($900k/год)

Стоимость инфраструктуры:
- Серверы (Hetzner): ~$5,000/мес
- CDN (CloudFlare): ~$2,000/мес
- Базы данных: ~$1,000/мес
- TURN серверы: ~$1,500/мес

Итого: ~$9,500/мес

Маржинальность: ~87%
```

---

# ЧАСТЬ 4: SWOT-АНАЛИЗ

## 4.1 Strengths (Сильные стороны)

| Сторона | Реализация | Приоритет |
|---------|-----------|-----------|
| Производительность | Go + WebSocket нативный | Критично |
| Масштабируемость | Redis Pub/Sub + горизонтальное масштабирование | Критично |
| AI-функции | SyncSense ML-модели | Высоко |
| Универсальность | Поддержка всех источников видео | Высоко |
| Низкая задержка | WebRTC + оптимизированная синхронизация | Критично |

## 4.2 Weaknesses (Слабые стороны)

| Сторона | Риск | Митигация |
|---------|------|-----------|
| Сложность разработки | Go + WebRTC сложнее Node.js | Инвестировать в документацию, использовать проверенные библиотеки |
| Инфраструктурные затраты | WebRTC требует TURN серверов | Оптимизировать relay, использовать P2P где возможно |
| ML экспертиза | Нужны data scientists | Начать с простых моделей, использовать готовые решения |
| Конкуренция | Уже есть Discord, Watch2Gether | Фокус на специализации (только видео), лучший UX |

## 4.3 Opportunities (Возможности)

| Возможность | Стратегия |
|-------------|-----------|
| Рост remote work | Позиционирование как инструмент для команд |
| Education market | Интеграция с LMS платформами |
| Live events | Партнерства с организаторами концертов |
| Metaverse | 3D комнаты с VR поддержкой |
| Content creators | Инструменты для монетизации |

## 4.4 Threats (Угрозы)

| Угроза | Защита |
|--------|--------|
| YouTube API changes | Множественные источники, fallback |
| DDoS атаки | CloudFlare, rate limiting |
| Copyright issues | Content ID система, модерация |
| Big players entry | Скорость разработки, нишевые фичи |

---

# ЧАСТЬ 5: ПЛАН РАЗРАБОТКИ

## Фаза 1: MVP (2-3 месяца)

### Месяц 1: Core Infrastructure

**Неделя 1-2: Проектирование**
- [ ] Финализация архитектуры
- [ ] Настройка CI/CD
- [ ] Создание репозиториев
- [ ] Docker-compose для локальной разработки

**Неделя 3-4: Auth + Basic API**
- [ ] Auth Service (Go + JWT)
- [ ] User Service (PostgreSQL)
- [ ] Room Service (PostgreSQL)
- [ ] Базовый REST API
- [ ] Интеграционные тесты

**Доставляемый результат:**
- Регистрация/авторизация
- Создание комнат
- Базовый API

### Месяц 2: Real-time Core

**Неделя 1-2: WebSocket Gateway**
- [ ] WebSocket сервер (Go + gorilla/websocket)
- [ ] Redis Pub/Sub интеграция
- [ ] Room management
- [ ] Presence tracking

**Неделя 3-4: Video Sync**
- [ ] CRDT state management
- [ ] Play/Pause/Seek синхронизация
- [ ] Latency compensation
- [ ] Базовый видео-плеер (React)

**Доставляемый результат:**
- Работающая синхронизация
- Базовый плеер
- Чат (без истории)

### Месяц 3: Video Sources + Polish

**Неделя 1-2: Video Integration**
- [ ] YouTube API интеграция
- [ ] Vimeo интеграция
- [ ] Загрузка локальных файлов (MinIO)
- [ ] Video queue management

**Неделя 3-4: UI/UX**
- [ ] React фронтенд
- [ ] Material-UI или Tailwind
- [ ] Responsive design
- [ ] Базовые анимации

**Доставляемый результат:**
- MVP готов к тестированию
- Поддержка YouTube + локальных файлов
- Базовый UI

---

## Фаза 2: Enhanced Experience (2 месяца)

### Месяц 4: Voice + Screen Share

**Неделя 1-2: WebRTC Integration**
- [ ] Mediasoup установка
- [ ] Voice chat (1-to-1)
- [ ] Voice chat (групповой)
- [ ] Echo cancellation

**Неделя 3-4: Screen Sharing**
- [ ] Screen capture API
- [ ] Screen share streaming
- [ ] Quality adaptation
- [ ] TURN server (Coturn)

**Доставляемый результат:**
- Голосовой чат
- Демонстрация экрана
- WebRTC инфраструктура

### Месяц 5: Chat + History

**Неделя 1-2: Chat System**
- [ ] ScyllaDB интеграция
- [ ] История сообщений
- [ ] Reactions
- [ ] @mentions

**Неделя 3-4: Advanced Features**
- [ ] Moderation tools
- [ ] User roles
- [ ] Room permissions
- [ ] Invitations system

**Доставляемый результат:**
- Полноценный чат
- Модерация
- Продвинутая система прав

---

## Фаза 3: AI + Scale (2 месяца)

### Месяц 6: SyncSense AI

**Неделя 1-2: ML Pipeline**
- [ ] TensorFlow Lite setup
- [ ] Emotion detection model
- [ ] Voice activity detection
- [ ] Network prediction

**Неделя 3-4: Smart Features**
- [ ] Predictive buffering
- [ ] Smart sync
- [ ] Emotion timestamps
- [ ] Content recommendations

**Доставляемый результат:**
- AI-функции работают
- Улучшенная синхронизация
- Рекомендации контента

### Месяц 7: Scale + Optimize

**Неделя 1-2: Performance**
- [ ] Load testing (k6)
- [ ] Connection pooling
- [ ] Query optimization
- [ ] CDN optimization

**Неделя 3-4: Monitoring**
- [ ] Prometheus + Grafana
- [ ] Distributed tracing (Jaeger)
- [ ] Error tracking (Sentry)
- [ ] Alerting

**Доставляемый результат:**
- Готовность к 10k+ пользователей
- Полный мониторинг
- Оптимизированная производительность

---

## Фаза 4: Monetization + Launch (2 месяца)

### Месяц 8: Payments + Subscriptions

**Неделя 1-2: Payment Integration**
- [ ] Stripe integration
- [ ] Subscription tiers
- [ ] Payment webhooks
- [ ] Invoice system

**Неделя 3-4: Premium Features**
- [ ] Feature flags
- [ ] Paywall implementation
- [ ] Trial system
- [ ] Referral program

### Месяц 9: Launch Prep

**Неделя 1-2: Polish**
- [ ] Bug fixing
- [ ] Performance tuning
- [ ] Security audit
- [ ] Documentation

**Неделя 3-4: Launch**
- [ ] Beta testing
- [ ] Marketing materials
- [ ] Product Hunt launch
- [ ] PR campaign

---

# ЧАСТЬ 6: DOCKER-COMPOSE КОНФИГУРАЦИЯ

## 6.1 Базовая конфигурация

```yaml
version: '3.8'

services:
  # PostgreSQL - основная БД
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: watchsync
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: watchsync
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U watchsync"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - backend

  # Redis - кэш и Pub/Sub
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - backend

  # ScyllaDB - чат и real-time данные
  scylla:
    image: scylladb/scylla:5.4
    command: --smp 2 --memory 2G --overprovisioned 1
    volumes:
      - scylla_data:/var/lib/scylla
    ports:
      - "9042:9042"
    networks:
      - backend
    healthcheck:
      test: ["CMD", "cqlsh", "-e", "describe keyspaces"]
      interval: 10s
      timeout: 10s
      retries: 10

  # MinIO - S3-совместимое хранилище
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes:
      - minio_data:/data
    ports:
      - "9000:9000"
      - "9001:9001"
    networks:
      - backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  # API Gateway (Kong)
  kong:
    image: kong:3.5
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /kong/declarative/kong.yml
      KONG_PROXY_ACCESS_LOG: /dev/stdout
      KONG_ADMIN_ACCESS_LOG: /dev/stdout
      KONG_PROXY_ERROR_LOG: /dev/stderr
      KONG_ADMIN_ERROR_LOG: /dev/stderr
      KONG_PLUGINS: bundled,rate-limiting
    volumes:
      - ./kong-config:/kong/declarative
    ports:
      - "8000:8000"
      - "8443:8443"
      - "8001:8001"
      - "8444:8444"
    networks:
      - backend
    depends_on:
      - auth-service
      - room-service

  # Auth Service
  auth-service:
    build:
      context: ./services/auth
      dockerfile: Dockerfile
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: watchsync
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: watchsync
      JWT_SECRET: ${JWT_SECRET}
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "8081:8080"
    networks:
      - backend
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '0.5'
          memory: 512M

  # Room Service
  room-service:
    build:
      context: ./services/room
      dockerfile: Dockerfile
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: watchsync
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: watchsync
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "8082:8080"
    networks:
      - backend
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '0.5'
          memory: 512M

  # WebSocket Gateway
  ws-gateway:
    build:
      context: ./services/ws-gateway
      dockerfile: Dockerfile
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
      WS_PORT: 8080
    ports:
      - "8083:8080"
    networks:
      - backend
    depends_on:
      redis:
        condition: service_healthy
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1.0'
          memory: 1G

  # Sync Service
  sync-service:
    build:
      context: ./services/sync
      dockerfile: Dockerfile
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
    networks:
      - backend
    depends_on:
      redis:
        condition: service_healthy
    deploy:
      replicas: 2

  # Chat Service
  chat-service:
    build:
      context: ./services/chat
      dockerfile: Dockerfile
    environment:
      SCYLLA_HOSTS: scylla:9042
      REDIS_HOST: redis
      REDIS_PORT: 6379
    networks:
      - backend
    depends_on:
      scylla:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      replicas: 2

  # Media Server (Mediasoup)
  media-server:
    build:
      context: ./services/media
      dockerfile: Dockerfile
    environment:
      MEDIASOUP_LISTEN_IP: 0.0.0.0
      MEDIASOUP_ANNOUNCED_IP: ${EXTERNAL_IP}
      MEDIASOUP_MIN_PORT: 40000
      MEDIASOUP_MAX_PORT: 49999
    ports:
      - "8084:8080"
      - "40000-49999:40000-49999/udp"
    networks:
      - backend
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '2.0'
          memory: 2G

  # TURN Server (Coturn)
  coturn:
    image: coturn/coturn:4.6.2
    network_mode: host
    volumes:
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: -c /etc/coturn/turnserver.conf
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M

  # Frontend (React)
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:80"
    networks:
      - backend
    depends_on:
      - kong
      - ws-gateway

  # Nginx Load Balancer
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    ports:
      - "80:80"
      - "443:443"
    networks:
      - backend
    depends_on:
      - ws-gateway
      - kong
      - frontend

  # Prometheus (monitoring)
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
    networks:
      - backend

  # Grafana (visualization)
  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/grafana/dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./monitoring/grafana/datasources:/etc/grafana/provisioning/datasources:ro
    ports:
      - "3001:3000"
    networks:
      - backend

volumes:
  postgres_data:
  redis_data:
  scylla_data:
  minio_data:
  prometheus_data:
  grafana_data:

networks:
  backend:
    driver: bridge
```

## 6.2 Production Scaling (Kubernetes)

```yaml
# Пример HorizontalPodAutoscaler для WebSocket Gateway
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ws-gateway-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ws-gateway
  minReplicas: 3
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: websocket_connections
      target:
        type: AverageValue
        averageValue: "1000"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 10
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 5
        periodSeconds: 60
```

---

# ЧАСТЬ 7: ТЕХНИЧЕСКИЕ СПЕЦИФИКАЦИИ

## 7.1 WebSocket Protocol

```typescript
// Client -> Server Messages
interface WSMessage {
  type: 'join_room' | 'leave_room' | 'video_action' | 'chat_message' | 'reaction' | 'ping';
  payload: unknown;
  timestamp: number;
}

// Video Action Payload
interface VideoActionPayload {
  action: 'play' | 'pause' | 'seek' | 'rate_change';
  time: number;
  rate?: number;
}

// Server -> Client Messages
interface ServerMessage {
  type: 'state_sync' | 'user_joined' | 'user_left' | 'chat_message' | 'error' | 'pong';
  payload: unknown;
  server_timestamp: number;
  latency_ms: number;
}

// State Sync Payload
interface StateSyncPayload {
  video_state: VideoState;
  users: UserPresence[];
  timestamp: number;
}
```

## 7.2 API Endpoints

```yaml
# Auth Service
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/refresh
GET    /api/v1/auth/me

# Room Service
POST   /api/v1/rooms              # Create room
GET    /api/v1/rooms/:id           # Get room info
PATCH  /api/v1/rooms/:id           # Update room
DELETE /api/v1/rooms/:id           # Delete room
POST   /api/v1/rooms/:id/join     # Join room
POST   /api/v1/rooms/:id/leave    # Leave room
GET    /api/v1/rooms/:id/members   # List members

# Video Service
POST   /api/v1/rooms/:id/queue     # Add to queue
GET    /api/v1/rooms/:id/queue     # Get queue
PATCH  /api/v1/queue/:item_id      # Update queue item
DELETE /api/v1/queue/:item_id      # Remove from queue

# Chat Service
GET    /api/v1/rooms/:id/messages  # Get messages (paginated)
POST   /api/v1/rooms/:id/messages  # Send message (WebSocket preferred)
```

## 7.3 Performance Targets

| Метрика | Цель | Методология |
|---------|------|-------------|
| Latency sync | < 100ms | CRDT + latency compensation |
| WebSocket connections | 100k/server | Go goroutines |
| Chat messages | 1M/min | ScyllaDB |
| Video startup | < 2s | CDN + prefetch |
| Voice latency | < 300ms | WebRTC + TURN |
| Screen share | < 500ms | Mediasoup SFU |
| Uptime | 99.9% | Kubernetes + HA |

---

# ЧАСТЬ 8: РЕКОМЕНДАЦИИ ПО РАЗРАБОТКЕ

## 8.1 Best Practices

### Go Backend
- Использовать context для cancellation
- Graceful shutdown
- Structured logging (zap)
- OpenTelemetry tracing
- Table-driven tests

### Frontend
- React hooks для WebSocket
- Virtual scrolling для чата
- Memoization для производительности
- Error boundaries
- Service workers для offline

### DevOps
- Infrastructure as Code (Terraform)
- GitOps (ArgoCD)
- Blue-green deployments
- Feature flags
- Chaos engineering

## 8.2 Security Checklist

- [ ] HTTPS everywhere
- [ ] WebSocket WSS
- [ ] JWT с коротким TTL
- [ ] Rate limiting
- [ ] Input validation
- [ ] SQL injection protection
- [ ] XSS protection
- [ ] CSRF tokens
- [ ] Content Security Policy
- [ ] DDoS protection (CloudFlare)

## 8.3 Testing Strategy

| Тип | Инструмент | Покрытие |
|-----|-----------|----------|
| Unit | Go test, Jest | 80%+ |
| Integration | Testcontainers | Критические пути |
| E2E | Playwright | Основные сценарии |
| Load | k6 | 10k+ concurrent |
| Chaos | Chaos Mesh | Отказоустойчивость |

---

# ЗАКЛЮЧЕНИЕ

## Ключевые преимущества данной архитектуры:

1. **Производительность:** Go + нативный WebSocket обеспечивают 10x производительность по сравнению с Node.js + Socket.io

2. **Масштабируемость:** Redis Pub/Sub позволяет горизонтально масштабировать до миллионов соединений

3. **Уникальность:** SyncSense AI - killer feature, которого нет у конкурентов

4. **Универсальность:** Поддержка всех источников видео + screen sharing + voice chat

5. **Экономика:** 87% маржинальность при правильной монетизации

## Следующие шаги:

1. Создать proof-of-concept (1 неделя)
2. Найти technical co-founder или команду
3. Запустить MVP (3 месяца)
4. Привлечь seed funding
5. Масштабировать

---

*Документ создан: 2026-03-22*
*Версия: 1.0*

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Config holds service configuration
type Config struct {
	Port               string        `json:"port"`
	RedisHost          string        `json:"redis_host"`
	RedisPort          string        `json:"redis_port"`
	RedisDB            int           `json:"redis_db"`
	NatsURL            string        `json:"nats_url"`
	MaxDrift           time.Duration `json:"max_drift"`
	BufferOffset       time.Duration `json:"buffer_offset"`
	HeartbeatIdleTime  time.Duration `json:"heartbeat_idle_time"`
	RoomCleanupTimeout time.Duration `json:"room_cleanup_timeout"`
	// Mutex for thread-safe config updates
	mu sync.RWMutex
}

// LoadConfig reads configuration from environment variables with defaults
func LoadConfig() *Config {
	return &Config{
		Port:               getEnv("PORT", "8080"),
		RedisHost:          getEnv("REDIS_HOST", "localhost"),
		RedisPort:          getEnv("REDIS_PORT", "6379"),
		RedisDB:            getEnvInt("REDIS_DB", 2),
		NatsURL:            getEnv("NATS_URL", "nats://localhost:4222"),
		MaxDrift:           time.Duration(getEnvInt("MAX_DRIFT_MS", 100)) * time.Millisecond,
		BufferOffset:       time.Duration(getEnvInt("BUFFER_OFFSET_MS", 50)) * time.Millisecond,
		HeartbeatIdleTime:  time.Duration(getEnvInt("HEARTBEAT_IDLE_MS", 1800000)) * time.Millisecond, // 30m
		RoomCleanupTimeout: time.Duration(getEnvInt("ROOM_CLEANUP_MS", 3600000)) * time.Millisecond,       // 1h
	}
}

func (c *Config) Get() *Config {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c
}

// VideoState represents the synchronized video state
type VideoState struct {
	RoomID       string           `json:"room_id"`
	CurrentTime  float64          `json:"current_time"`
	PlaybackRate float64          `json:"playback_rate"`
	IsPlaying    bool             `json:"is_playing"`
	Timestamp    int64            `json:"timestamp"`
	Source       string           `json:"source"`
	Version      uint64           `json:"version"`
	LatencyMap   map[string]int64 `json:"latency_map,omitempty"`
	VideoURL     string           `json:"video_url,omitempty"`
	PlayerType   string           `json:"player_type,omitempty"`
	IsSeeking    bool             `json:"is_seeking,omitempty"`
}

// roomHeartbeat tracks per-room periodic broadcast goroutine lifecycle and state control
type roomHeartbeat struct {
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex // Protects the LastActionTime
	LastActionTime time.Time
}

func newRoomHeartbeat() *roomHeartbeat {
	ctx, cancel := context.WithCancel(context.Background())
	return &roomHeartbeat{
		ctx:            ctx,
		cancel:         cancel,
		LastActionTime: time.Now(),
	}
}

// Stop cleans up resources for a room's heartbeat process.
func (hb *roomHeartbeat) Stop() {
	hb.cancel()
}

// GetLastAction returns the last time an event-driven state_sync was published.
func (hb *roomHeartbeat) GetLastAction() time.Time {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	return hb.LastActionTime
}

// UpdateLastAction records a recent action, resetting the idle timer.
func (hb *roomHeartbeat) UpdateLastAction(t time.Time) {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	hb.LastActionTime = t
}

type SyncEngine struct {
	config     *Config
	redis      *redis.Client
	nats       *nats.Conn
	rooms      map[string]*RoomSync
	mu         sync.RWMutex
	heartbeats map[string]*roomHeartbeat
	hbMu       sync.Mutex
}

// RoomSync manages synchronization for a single room
type RoomSync struct {
	RoomID              string
	State               *VideoState
	Clients             map[string]*ClientSync
	LastUpdate          time.Time
	LastActionBroadcast time.Time // when the last event-driven state_sync was published
	mu                  sync.RWMutex
}

// ClientSync tracks client synchronization state
type ClientSync struct {
	UserID   string
	Latency  time.Duration
	LastPing time.Time
	Drift    time.Duration
}

// Prometheus metrics
var (
	activeRooms = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sync_service_active_rooms",
		Help: "Number of active rooms in sync engine",
	})
	syncOperations = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sync_service_operations_total",
		Help: "Total sync operations processed",
	}, []string{"action"})
	activeHeartbeats = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sync_service_active_heartbeats",
		Help: "Number of rooms with active heartbeat goroutines",
	})
)

// NewSyncEngine creates a new synchronization engine
func NewSyncEngine(cfg *Config) *SyncEngine {
	return &SyncEngine{
		config:     cfg,
		rooms:      make(map[string]*RoomSync),
		heartbeats: make(map[string]*roomHeartbeat),
	}
}

// Initialize sets up connections
func (se *SyncEngine) Initialize() error {
	cfg := se.config.Get()
	se.redis = redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", cfg.RedisHost, cfg.RedisPort),
		DB:       cfg.RedisDB,
		PoolSize: 100,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := se.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	nc, err := nats.Connect(cfg.NatsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(10),
		nats.ReconnectWait(2*time.Second),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			log.Printf("NATS async error: %v", err)
		}),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Printf("NATS disconnected: %v", err)
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			log.Printf("NATS reconnected")
		}),
	)
	if err != nil {
		return fmt.Errorf("nats connection failed: %w", err)
	}
	se.nats = nc
	log.Println("Connected to NATS")

	// Subscribe to video actions from ws-gateway (deep copy msg.Data — NATS reuses buffer)
	_, err = nc.Subscribe("room.*.video_action", func(msg *nats.Msg) {
		msgCopy := *msg
		msgCopy.Data = make([]byte, len(msg.Data))
		copy(msgCopy.Data, msg.Data)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("NATS handler panic: %v", r)
				}
			}()
			log.Printf("NATS video_action received on subject %s", msgCopy.Subject)
			se.handleVideoAction(&msgCopy)
		}()
	})
	if err != nil {
		return fmt.Errorf("nats video_action subscription failed: %w", err)
	}

	// Subscribe to ping messages for latency tracking
	_, err = nc.Subscribe("room.*.ping", se.handlePing)
	if err != nil {
		return fmt.Errorf("nats ping subscription failed: %w", err)
	}

	// Subscribe to status probes from clients
	_, err = nc.Subscribe("room.*.status_probe", se.handleStatusProbe)
	if err != nil {
		return fmt.Errorf("nats status_probe subscription failed: %w", err)
	}

	return nil
}

// handleVideoAction processes video actions from clients
func (se *SyncEngine) handleVideoAction(msg *nats.Msg) {
	var action struct {
		RoomID    string  `json:\"room_id\"`
		UserID    string  `json:\"user_id\"`
		Action    string  `json:\"action\"`
		Time      float64 `json:\"time\"`
		Rate      float64 `json:\"rate\"`
		Source    string  `json:\"source\"`
		Version   uint64  `json:\"version\"`
		Timestamp int64   `json:\"timestamp\"`
		ClientID  string  `json:\"client_id,omitempty\"` // per-tab session ID (echo guard)
	}

	var wrapper struct {
		Payload json.RawMessage `json:\"payload\"`
		RoomID  string          `json:\"room_id\"`
		UserID  string          `json:\"user_id\"`
	}

	if err := json.Unmarshal(msg.Data, &wrapper); err == nil && wrapper.Payload != nil {
		json.Unmarshal(wrapper.Payload, &action)
		// Fallback: extract room_id/user_id from raw JSON if wrapper fields are empty
		var raw map[string]json.RawMessage
		if action.RoomID == "" && json.Unmarshal(msg.Data, &raw) == nil {
			if v, ok := raw["room_id"]; ok { json.Unmarshal(v, &action.RoomID) }
			if v, ok := raw["user_id"]; ok { json.Unmarshal(v, &action.UserID) }
		}
		if action.RoomID == "" { action.RoomID = wrapper.RoomID }
		if action.UserID == "" { action.UserID = wrapper.UserID }
	} else {
		if err := json.Unmarshal(msg.Data, &action); err != nil {
			log.Printf("Error unmarshaling video action: %v", err)
			return
		}
	}

	if action.RoomID == "" {
		return
	}

	room := se.getOrCreateRoom(action.RoomID)

	room.mu.Lock()
	defer room.mu.Unlock()

	newState := &VideoState{
		RoomID:       action.RoomID,
		CurrentTime:  action.Time,
		PlaybackRate: action.Rate,
		Timestamp:    time.Now().UnixMilli(),
		Source:       action.UserID,
		Version:      action.Version,
	}

	switch action.Action {
	case "play":
		newState.IsPlaying = true
	case "pause":
		newState.IsPlaying = false
	case "seek":
		newState.CurrentTime = action.Time
		if room.State != nil {
			newState.IsPlaying = room.State.IsPlaying
		}
	case "rate_change":
		newState.PlaybackRate = action.Rate
		if room.State != nil {
			newState.IsPlaying = room.State.IsPlaying
		}
	}

	if newState.PlaybackRate == 0 {
		newState.PlaybackRate = 1.0
	}

	if action.Action == "play" || action.Action == "pause" {
		if room.State != nil {
			if action.Time <= 0 && room.State.CurrentTime > 0 {
				newState.CurrentTime = room.State.CurrentTime
			}
			newState.PlaybackRate = room.State.PlaybackRate
			if newState.PlaybackRate == 0 {
				newState.PlaybackRate = 1.0
			}
		}
		room.State = newState
	} else {
		room.State = se.mergeStates(room.State, newState)
	}
	room.LastUpdate = time.Now()

	go se.ensureHeartbeat(action.RoomID)


	broadcast := map[string]interface{}{
		"type":    "state_sync",
		"room_id": action.RoomID,
		"payload": map[string]interface{}{
			"source_user_id":   action.UserID,
			"source_client_id": action.ClientID, // per-tab echo guard (empty for heartbeats)
			"state": map[string]interface{}{
				"is_playing":    room.State.IsPlaying,
				"current_time":  room.State.CurrentTime,
				"playback_rate": room.State.PlaybackRate,
				"timestamp":     room.State.Timestamp,
			},
			"adjusted_time": se.calculateAdjustedTimeFrom(newState, room.LastUpdate),
		},
		"timestamp": time.Now().UnixMilli(),
	}

	data, _ := json.Marshal(broadcast)
	se.nats.Publish(fmt.Sprintf("room.%s.broadcast", action.RoomID), data)
	room.LastActionBroadcast = time.Now() // cooldown: heartbeat skips for 500ms after this

	syncOperations.WithLabelValues(action.Action).Inc()
	log.Printf("Synced room %s: %s @ %.2f (v%d)", action.RoomID, action.Action, action.Time, action.Version)
}

func (se *SyncEngine) handlePing(msg *nats.Msg) {
	var ping struct {
		RoomID    string `json:\"room_id\"`
		UserID    string `json:\"user_id\"`
		Timestamp int64  `json:\"timestamp\"`
	}

	if err := json.Unmarshal(msg.Data, &ping); err != nil {
		return
	}

	room := se.getOrCreateRoom(ping.RoomID)

	now := time.Now().UnixMilli()
	rtt := now - ping.Timestamp
	latency := time.Duration(rtt/2) * time.Millisecond

	room.mu.Lock()
	if room.Clients[ping.UserID] == nil {
		room.Clients[ping.UserID] = &ClientSync{UserID: ping.UserID}
	}
	room.Clients[ping.UserID].Latency = latency
	room.Clients[ping.UserID].LastPing = time.Now()
	room.mu.Unlock()

	pong := map[string]interface{}{
		"type":       "pong",
		"timestamp":  now,
		"latency_ms": latency.Milliseconds(),
	}
	data, _ := json.Marshal(pong)
	se.nats.Publish(fmt.Sprintf("room.%s.user.%s", ping.RoomID, ping.UserID), data)
}

func (se *SyncEngine) handleStatusProbe(msg *nats.Msg) {
	var wrapper struct {
		Payload json.RawMessage `json:\"payload\"`
		RoomID  string          `json:\"room_id\"`
		UserID  string          `json:\"user_id\"`
	}
	if err := json.Unmarshal(msg.Data, &wrapper); err != nil || wrapper.RoomID == "" || wrapper.UserID == "" {
		return
	}

	se.mu.RLock()
	room, ok := se.rooms[wrapper.RoomID]
	se.mu.RUnlock()
	if !ok || room.State == nil {
		return
	}

	room.mu.RLock()
	state := room.State
	lastUpdate := room.LastUpdate
	room.mu.RUnlock()

	adjustedTime := se.calculateAdjustedTimeFrom(state, lastUpdate)

	data, _ := json.Marshal(map[string]interface{}{
		"type":    "state_sync",
		"room_id": wrapper.RoomID,
		"payload": map[string]interface{}{
			"source_user_id": "_probe_response",
			"state": map[string]interface{}{
				"is_playing":    state.IsPlaying,
				"current_time":  state.CurrentTime,
				"playback_rate": state.PlaybackRate,
				"timestamp":     state.Timestamp,
			},
			"adjusted_time": adjustedTime,
		},
		"timestamp": time.Now().UnixMilli(),
	})
	se.nats.Publish(fmt.Sprintf("room.%s.user.%s", wrapper.RoomID, wrapper.UserID), data)
	syncOperations.WithLabelValues("probe_response").Inc()
}

func (se *SyncEngine) ensureHeartbeat(roomID string) {
	se.hbMu.Lock()
	defer se.hbMu.Unlock()

	if hb, ok := se.heartbeats[roomID]; ok {
		hb.mu.Lock()
		hb.LastActionTime = time.Now()
		hb.mu.Unlock()
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	hb := &roomHeartbeat{
		cancel:         cancel,
		LastActionTime: time.Now(),
	}
	se.heartbeats[roomID] = hb
	activeHeartbeats.Inc()
	go se.runHeartbeat(ctx, roomID, hb)
}

func (se *SyncEngine) runHeartbeat(ctx context.Context, roomID string, hb *roomHeartbeat) {
	defer activeHeartbeats.Dec()

	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hb.mu.Lock()
			idle := time.Since(hb.LastActionTime) > se.config.Get().HeartbeatIdleTime
			hb.mu.Unlock()

			if idle {
				se.hbMu.Lock()
				delete(se.heartbeats, roomID)
				se.hbMu.Unlock()
				hb.cancel()
				return
			}

			se.mu.RLock()
			room, ok := se.rooms[roomID]
			se.mu.RUnlock()
			if !ok {
				continue
			}

			room.mu.RLock()
			isPlaying := room.State != nil && room.State.IsPlaying
			room.mu.RUnlock()

			if isPlaying {
				ticker.Reset(4 * time.Second)
			} else {
				ticker.Reset(10 * time.Second)
			}

			se.broadcastHeartbeat(roomID)
		}
	}
}

func (se *SyncEngine) broadcastHeartbeat(roomID string) {
	se.mu.RLock()
	room, ok := se.rooms[roomID]
	se.mu.RUnlock()
	if !ok {
		return
	}

	room.mu.RLock()
	state := room.State
	lastUpdate := room.LastUpdate
	sinceLast := time.Since(room.LastActionBroadcast)
	room.mu.RUnlock()
	if state == nil {
		return
	}

	if sinceLast < 500*time.Millisecond {
		return
	}

	adjustedTime := se.calculateAdjustedTimeFrom(state, lastUpdate)

	data, _ := json.Marshal(map[string]interface{}{
		"type":    "state_sync",
		"room_id": roomID,
		"payload": map[string]interface{}{
			"source_user_id": "_heartbeat",
			"state": map[string]interface{}{
				"is_playing":    state.IsPlaying,
				"current_time":  state.CurrentTime,
				"playback_rate": state.PlaybackRate,
				"timestamp":     state.Timestamp,
			},
			"adjusted_time": adjustedTime,
		},
		"timestamp": time.Now().UnixMilli(),
	})
	se.nats.Publish(fmt.Sprintf("room.%s.broadcast", roomID), data)
	syncOperations.WithLabelValues("heartbeat").Inc()
	log.Printf("[heartbeat] room %s: %.2fs playing=%v", roomID, adjustedTime, state.IsPlaying)
}

func (se *SyncEngine) mergeStates(old, newState *VideoState) *VideoState {
	if old == nil {
		return newState
	}
	if newState.Version > old.Version {
		return newState
	}
	if old.Version > newState.Version {
		return old
	}
	if newState.Timestamp > old.Timestamp {
		return newState
	}
	return old
}

func (se *SyncEngine) calculateAdjustedTimeFrom(state *VideoState, lastUpdate time.Time) float64 {
	if state == nil {
		return 0
	}
	if !state.IsPlaying {
		return state.CurrentTime
	}
	se.config.mu.RLock()
	offset := se.config.BufferOffset
	se.config.mu.RUnlock()
	elapsed := time.Since(lastUpdate).Seconds()
	return state.CurrentTime + (elapsed * state.PlaybackRate) + offset.Seconds()
}

func (se *SyncEngine) calculateAdjustedTime(room *RoomSync) float64 {
	return se.calculateAdjustedTimeFrom(room.State, room.LastUpdate)
}

func (se *SyncEngine) getOrCreateRoom(roomID string) *RoomSync {
	se.mu.Lock()
	defer se.mu.Unlock()

	if room, ok := se.rooms[roomID]; ok {
		return room
	}

	room := &RoomSync{
		RoomID:  roomID,
		Clients: make(map[string]*ClientSync),
		State: &VideoState{
			RoomID:       roomID,
			PlaybackRate: 1.0,
		},
	}
	se.rooms[roomID] = room
	activeRooms.Inc()

	se.restoreStateFromRedis(room)

	return room
}

func (se *SyncEngine) saveStateToRedis(state *VideoState) {
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:video_state", state.RoomID)
	data, _ := json.Marshal(state)
	se.redis.Set(ctx, key, data, 24*time.Hour)
}

func (se *SyncEngine) restoreStateFromRedis(room *RoomSync) {
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:video_state", room.RoomID)

	data, err := se.redis.Get(ctx, key).Result()
	if err != nil {
		return
	}

	var state VideoState
	if err := json.Unmarshal([]byte(data), &state); err != nil {
		return
	}

	room.State = &state
	log.Printf("Restored state for room %s from Redis", room.RoomID)
}

func (se *SyncEngine) cleanupRooms() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		se.mu.RLock()
		var toDelete []string
		for roomID, room := range se.rooms {
			room.mu.RLock()
			if time.Since(room.LastUpdate) > 1*time.Hour {
				toDelete = append(toDelete, roomID)
			}
			room.mu.RUnlock()
		}
		se.mu.RUnlock()

		if len(toDelete) == 0 {
			continue
		}

		se.mu.Lock()
		for _, roomID := range toDelete {
			room, ok := se.rooms[roomID]
			if !ok {
				continue
			}
			room.mu.RLock()
			stillInactive := time.Since(room.LastUpdate) > 1*time.Hour
			room.mu.RUnlock()
			if stillInactive {
				delete(se.rooms, roomID)
				activeRooms.Dec()
				log.Printf("Cleaned up inactive room: %s", roomID)
			}
		}
		se.mu.Unlock()

		for _, roomID := range toDelete {
			se.hbMu.Lock()
			if hb, ok := se.heartbeats[roomID]; ok {
				hb.cancel()
				delete(se.heartbeats, roomID)
			}
			se.hbMu.Unlock()
		}
	}
}

// HTTP handlers
func (se *SyncEngine) handleGetState(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room_id")
	if roomID == "" {
		http.Error(w, "room_id required", http.StatusBadRequest)
		return
	}

	room := se.getOrCreateRoom(roomID)

	room.mu.RLock()
	state := room.State
	room.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

func (se *SyncEngine) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"healthy","service":"sync-service"}`))
}

func (se *SyncEngine) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	se.config.mu.RLock()
	resp := map[string]interface{}{
		"buffer_offset_ms": se.config.BufferOffset.Milliseconds(),
		"max_drift_ms":     se.config.MaxDrift.Milliseconds(),
	}
	se.config.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (se *SyncEngine) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		BufferOffsetMs *int64 `json:\"buffer_offset_ms\"`
		MaxDriftMs     *int64 `json:\"max_drift_ms\"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	se.config.mu.Lock()
	if req.BufferOffsetMs != nil {
		se.config.BufferOffset = time.Duration(*req.BufferOffsetMs) * time.Millisecond
	}
	if req.MaxDriftMs != nil {
		se.config.MaxDrift = time.Duration(*req.MaxDriftMs) * time.Millisecond
	}
	resp := map[string]interface{}{
		"buffer_offset_ms": se.config.BufferOffset.Milliseconds(),
		"max_drift_ms":     se.config.MaxDrift.Milliseconds(),
	}
	se.config.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultValue
}

func main() {
	config := LoadConfig()

	engine := NewSyncEngine(config)
	if err := engine.Initialize(); err != nil {
		log.Fatalf("Failed to initialize engine: %v", err)
	}

	go engine.cleanupRooms()

	mux := http.NewServeMux()
	mux.HandleFunc("/state", engine.handleGetState)
	mux.HandleFunc("/health", engine.handleHealth)
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			engine.handleGetConfig(w, r)
		} else {
			engine.handleUpdateConfig(w, r)
		}
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Sync service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/nats-io/nats.go"
)

// Config holds service configuration
type Config struct {
	Port         string        `env:"PORT" envDefault:"8080"`
	RedisHost    string        `env:"REDIS_HOST" envDefault:"localhost"`
	RedisPort    string        `env:"REDIS_PORT" envDefault:"6379"`
	RedisDB      int           `env:"REDIS_DB" envDefault:"2"`
	NatsURL      string        `env:"NATS_URL" envDefault:"nats://localhost:4222"`
	SyncInterval time.Duration `env:"SYNC_INTERVAL" envDefault:"50ms"`
	MaxDrift     time.Duration `env:"MAX_DRIFT" envDefault:"100ms"`
	BufferOffset time.Duration `env:"BUFFER_OFFSET" envDefault:"50ms"`
}

// VideoState represents the synchronized video state
type VideoState struct {
	RoomID        string    `json:"room_id"`
	CurrentTime   float64   `json:"current_time"`
	PlaybackRate  float64   `json:"playback_rate"`
	IsPlaying     bool      `json:"is_playing"`
	Timestamp     int64     `json:"timestamp"`      // Server timestamp (ms)
	Source        string    `json:"source"`         // User who made the change
	Version       uint64    `json:"version"`        // Lamport timestamp for CRDT
	LatencyMap    map[string]int64 `json:"latency_map,omitempty"` // Client latencies
}

// SyncEngine handles video synchronization
type SyncEngine struct {
	config    *Config
	redis     *redis.Client
	nats      *nats.Conn
	rooms     map[string]*RoomSync
	mu        sync.RWMutex
}

// RoomSync manages synchronization for a single room
type RoomSync struct {
	RoomID       string
	State        *VideoState
	Clients      map[string]*ClientSync
	LastUpdate   time.Time
	mu           sync.RWMutex
}

// ClientSync tracks client synchronization state
type ClientSync struct {
	UserID       string
	Latency      time.Duration
	LastPing     time.Time
	Drift        time.Duration
}

// NewSyncEngine creates a new synchronization engine
func NewSyncEngine(cfg *Config) *SyncEngine {
	return &SyncEngine{
		config: cfg,
		rooms:  make(map[string]*RoomSync),
	}
}

// Initialize sets up connections
func (se *SyncEngine) Initialize() error {
	// Initialize Redis
	se.redis = redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", se.config.RedisHost, se.config.RedisPort),
		DB:       se.config.RedisDB,
		PoolSize: 100,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := se.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	// Initialize NATS
	nc, err := nats.Connect(se.config.NatsURL)
	if err != nil {
		return fmt.Errorf("nats connection failed: %w", err)
	}
	se.nats = nc
	log.Println("Connected to NATS")

	// Subscribe to video actions
	_, err = nc.Subscribe("room.*.video_action", se.handleVideoAction)
	if err != nil {
		return fmt.Errorf("nats subscription failed: %w", err)
	}

	// Subscribe to ping messages for latency tracking
	_, err = nc.Subscribe("room.*.ping", se.handlePing)
	if err != nil {
		return fmt.Errorf("nats ping subscription failed: %w", err)
	}

	return nil
}

// handleVideoAction processes video actions from clients
func (se *SyncEngine) handleVideoAction(msg *nats.Msg) {
	var action struct {
		RoomID    string  `json:"room_id"`
		UserID    string  `json:"user_id"`
		Action    string  `json:"action"`
		Time      float64 `json:"time"`
		Rate      float64 `json:"rate"`
		Source    string  `json:"source"`
		Version   uint64  `json:"version"`
		Timestamp int64   `json:"timestamp"`
	}

	if err := json.Unmarshal(msg.Data, &action); err != nil {
		log.Printf("Error unmarshaling video action: %v", err)
		return
	}

	room := se.getOrCreateRoom(action.RoomID)
	
	room.mu.Lock()
	defer room.mu.Unlock()

	// Apply CRDT merge
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
	case "rate_change":
		newState.PlaybackRate = action.Rate
	}

	// Merge with existing state using CRDT
	room.State = se.mergeStates(room.State, newState)
	room.LastUpdate = time.Now()

	// Store in Redis
	se.saveStateToRedis(room.State)

	// Calculate adjusted time for each client
	adjustedTime := se.calculateAdjustedTime(room)

	// Broadcast synchronized state
	broadcast := &struct {
		Type      string       `json:"type"`
		State     *VideoState  `json:"state"`
		Adjusted  float64      `json:"adjusted_time"`
		Timestamp int64        `json:"timestamp"`
	}{
		Type:      "state_sync",
		State:     room.State,
		Adjusted:  adjustedTime,
		Timestamp: time.Now().UnixMilli(),
	}

	data, _ := json.Marshal(broadcast)
	se.nats.Publish(fmt.Sprintf("room.%s.broadcast", action.RoomID), data)

	log.Printf("Synced room %s: %s @ %.2f (v%d)", 
		action.RoomID, action.Action, action.Time, action.Version)
}

// handlePing processes ping messages for latency tracking
func (se *SyncEngine) handlePing(msg *nats.Msg) {
	var ping struct {
		RoomID    string `json:"room_id"`
		UserID    string `json:"user_id"`
		Timestamp int64  `json:"timestamp"`
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

	// Send pong with server timestamp
	pong := map[string]interface{}{
		"type":       "pong",
		"timestamp":  now,
		"latency_ms": latency.Milliseconds(),
	}
	data, _ := json.Marshal(pong)
	se.nats.Publish(fmt.Sprintf("room.%s.user.%s", ping.RoomID, ping.UserID), data)
}

// mergeStates merges two video states using CRDT rules
func (se *SyncEngine) mergeStates(old, new *VideoState) *VideoState {
	if old == nil {
		return new
	}

	// Higher version wins
	if new.Version > old.Version {
		return new
	}
	if old.Version > new.Version {
		return old
	}

	// Same version - use timestamp (last write wins)
	if new.Timestamp > old.Timestamp {
		return new
	}

	return old
}

// calculateAdjustedTime calculates time adjusted for client latencies
func (se *SyncEngine) calculateAdjustedTime(room *RoomSync) float64 {
	room.mu.RLock()
	defer room.mu.RUnlock()

	if room.State == nil {
		return 0
	}

	if !room.State.IsPlaying {
		return room.State.CurrentTime
	}

	// Calculate elapsed time since last update
	elapsed := time.Since(room.LastUpdate).Seconds()
	adjusted := room.State.CurrentTime + (elapsed * room.State.PlaybackRate)

	// Add buffer offset for network jitter
	adjusted += se.config.BufferOffset.Seconds()

	return adjusted
}

// getOrCreateRoom gets or creates a room sync
func (se *SyncEngine) getOrCreateRoom(roomID string) *RoomSync {
	se.mu.Lock()
	defer se.mu.Unlock()

	if room, ok := se.rooms[roomID]; ok {
		return room
	}

	room := &RoomSync{
		RoomID:   roomID,
		Clients:  make(map[string]*ClientSync),
		State: &VideoState{
			RoomID:       roomID,
			PlaybackRate: 1.0,
		},
	}
	se.rooms[roomID] = room

	// Try to restore state from Redis
	se.restoreStateFromRedis(room)

	return room
}

// saveStateToRedis saves state to Redis
func (se *SyncEngine) saveStateToRedis(state *VideoState) {
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:video_state", state.RoomID)
	
	data, _ := json.Marshal(state)
	se.redis.Set(ctx, key, data, 24*time.Hour)
}

// restoreStateFromRedis restores state from Redis
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
	log.Printf("Restored state for room %s", room.RoomID)
}

// cleanupRooms removes inactive rooms
func (se *SyncEngine) cleanupRooms() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		se.mu.Lock()
		for roomID, room := range se.rooms {
			room.mu.RLock()
			inactive := time.Since(room.LastUpdate) > 1*time.Hour
			room.mu.RUnlock()

			if inactive {
				delete(se.rooms, roomID)
				log.Printf("Cleaned up inactive room: %s", roomID)
			}
		}
		se.mu.Unlock()
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
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"healthy"}`))
}

func (se *SyncEngine) handleMetrics(w http.ResponseWriter, r *http.Request) {
	se.mu.RLock()
	roomCount := len(se.rooms)
	se.mu.RUnlock()

	stats := map[string]interface{}{
		"rooms": roomCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func main() {
	config := &Config{
		Port:         getEnv("PORT", "8080"),
		RedisHost:    getEnv("REDIS_HOST", "localhost"),
		RedisPort:    getEnv("REDIS_PORT", "6379"),
		NatsURL:      getEnv("NATS_URL", "nats://localhost:4222"),
		SyncInterval: 50 * time.Millisecond,
		MaxDrift:     100 * time.Millisecond,
		BufferOffset: 50 * time.Millisecond,
	}

	engine := NewSyncEngine(config)
	if err := engine.Initialize(); err != nil {
		log.Fatalf("Failed to initialize engine: %v", err)
	}

	// Start cleanup goroutine
	go engine.cleanupRooms()

	// HTTP server
	http.HandleFunc("/state", engine.handleGetState)
	http.HandleFunc("/health", engine.handleHealth)
	http.HandleFunc("/metrics", engine.handleMetrics)

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Sync service starting on %s", addr)

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

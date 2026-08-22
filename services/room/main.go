package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Config struct {
	Port        string
	DBHost      string
	DBPort      string
	DBUser      string
	DBPassword  string
	DBName      string
	DBSSLMode   string
	RedisHost   string
	RedisPort   string
	NatsURL     string
	MaxRoomSize int
}

type Server struct {
	config *Config
	db     *pgxpool.Pool
	redis  *redis.Client
	nats   *nats.Conn
}

type RoomSettings struct {
	IsPublic  bool   `json:"is_public"`
	MaxUsers  int    `json:"max_users"`
	AllowChat bool   `json:"allow_chat"`
	SyncMode  string `json:"sync_mode"`
	Password  string `json:"password,omitempty"`
	IsAdult   bool   `json:"is_adult"` // 18+ room — only users verified 18+ can join
}

type VideoState struct {
	CurrentTime  float64 `json:"current_time"`
	IsPlaying    bool    `json:"is_playing"`
	PlaybackRate float64 `json:"playback_rate"`
}

type Room struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Slug         string       `json:"slug"`
	OwnerID      string       `json:"owner_id,omitempty"`
	VideoSource  string       `json:"video_source,omitempty"`
	VideoURL     string       `json:"video_url,omitempty"`
	Settings     RoomSettings `json:"settings"`
	CurrentState VideoState   `json:"current_state"`
	RoomType     int          `json:"room_type"` // 1=public, 2=password, 3=private
	CreatedAt    time.Time    `json:"created_at"`
	ExpiresAt    *time.Time   `json:"expires_at,omitempty"`
}

type CreateRoomRequest struct {
	Name       string `json:"name"`
	IsPublic   bool   `json:"is_public"`
	RoomType   int    `json:"room_type"` // 1=public, 2=password, 3=private
	Password   string `json:"password,omitempty"`
	MaxUsers   int    `json:"max_users,omitempty"`
	Persistent bool   `json:"persistent"` // true = no TTL, false = expires in 24h
	IsAdult    bool   `json:"is_adult"`   // 18+ room
}

type RoomEvent struct {
	ID        string          `json:"id"`
	RoomID    string          `json:"room_id"`
	EventType string          `json:"event_type"`
	UserID    string          `json:"user_id,omitempty"`
	Username  string          `json:"username,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

type JoinRoomRequest struct {
	UserID   string `json:"user_id"`
	UserName string `json:"username"`
	Password string `json:"password,omitempty"`
}

// extractCallerFromToken decodes the JWT payload (without verification) to get user_id and is_admin.
// Kong/auth-service already validated the token upstream.
func extractCallerFromToken(authHeader string) (userID string, isAdmin bool) {
	token := strings.TrimPrefix(authHeader, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	payload := parts[1]
	// Fix base64 padding
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}
	data, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return "", false
	}
	var claims map[string]interface{}
	if err := json.Unmarshal(data, &claims); err != nil {
		return "", false
	}
	uid, _ := claims["user_id"].(string)
	admin, _ := claims["is_admin"].(bool)
	return uid, admin
}

func NewServer(cfg *Config) *Server {
	return &Server{config: cfg}
}

func (s *Server) Initialize() error {
	connStr := fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=%s pool_max_conns=25",
		s.config.DBHost, s.config.DBPort, s.config.DBUser,
		s.config.DBPassword, s.config.DBName, s.config.DBSSLMode,
	)
	var pool *pgxpool.Pool
	var pgErr error
	for attempt := 1; attempt <= 5; attempt++ {
		pool, pgErr = pgxpool.New(context.Background(), connStr)
		if pgErr == nil {
			if pgErr = pool.Ping(context.Background()); pgErr == nil {
				break
			}
		}
		log.Printf("Postgres connection attempt %d/5 failed: %v", attempt, pgErr)
		if attempt < 5 {
			time.Sleep(3 * time.Second)
		}
	}
	if pgErr != nil {
		return fmt.Errorf("postgres connection failed after 5 attempts: %w", pgErr)
	}
	s.db = pool
	log.Println("Connected to PostgreSQL")

	s.redis = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:%s", s.config.RedisHost, s.config.RedisPort),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	nc, err := nats.Connect(s.config.NatsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(10),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return fmt.Errorf("nats connection failed: %w", err)
	}
	s.nats = nc
	log.Println("Connected to NATS")

	if err := s.migrateRoomEvents(); err != nil {
		return fmt.Errorf("room_events migration failed: %w", err)
	}

	s.subscribeEventLogging()
	go s.cleanupExpiredRooms()

	return nil
}

func (s *Server) migrateRoomEvents() error {
	_, err := s.db.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS room_events (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			room_id    UUID NOT NULL,
			event_type VARCHAR(50) NOT NULL,
			user_id    TEXT,
			username   TEXT,
			payload    JSONB,
			created_at TIMESTAMP DEFAULT NOW()
		);
		CREATE INDEX IF NOT EXISTS idx_room_events_room
			ON room_events(room_id, created_at DESC);
	`)
	return err
}

func (s *Server) logRoomEvent(roomID, eventType, userID, username string, payload interface{}) {
	var payloadStr *string
	if payload != nil {
		b, _ := json.Marshal(payload)
		ps := string(b)
		payloadStr = &ps
	}
	_, err := s.db.Exec(context.Background(),
		`INSERT INTO room_events (room_id, event_type, user_id, username, payload)
		 VALUES ($1::uuid, $2, NULLIF($3,''), NULLIF($4,''), $5::jsonb)`,
		roomID, eventType, userID, username, payloadStr,
	)
	if err != nil {
		log.Printf("logRoomEvent error: %v", err)
	}
}

func (s *Server) subscribeEventLogging() {
	// Log user join events
	s.nats.Subscribe("room.*.joined", func(msg *nats.Msg) {
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			return
		}
		roomID, _ := data["room_id"].(string)
		userID, _ := data["user_id"].(string)
		username, _ := data["username"].(string)
		if roomID != "" {
			s.logRoomEvent(roomID, "join", userID, username, nil)
		}
	})

	// Log user leave events
	s.nats.Subscribe("room.*.left", func(msg *nats.Msg) {
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			return
		}
		roomID, _ := data["room_id"].(string)
		userID, _ := data["user_id"].(string)
		username, _ := data["username"].(string)
		if roomID != "" {
			s.logRoomEvent(roomID, "leave", userID, username, nil)
		}
	})

	// Log broadcast events of interest (video, queue changes)
	s.nats.Subscribe("room.*.broadcast", func(msg *nats.Msg) {
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			return
		}
		roomID, _ := data["room_id"].(string)
		msgType, _ := data["type"].(string)
		if roomID == "" {
			return
		}
		switch msgType {
		case "video_action", "queue_updated", "room_settings_updated":
			s.logRoomEvent(roomID, msgType, "", "", data["payload"])
		}
	})
}

func (s *Server) cleanupExpiredRooms() {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		result, err := s.db.Exec(context.Background(),
			`DELETE FROM rooms WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
		)
		if err != nil {
			log.Printf("cleanupExpiredRooms error: %v", err)
			continue
		}
		if n := result.RowsAffected(); n > 0 {
			log.Printf("cleanupExpiredRooms: deleted %d expired rooms", n)
		}
	}
}

// POST /api/v1/rooms
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req CreateRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	if len(req.Name) < 1 || len(req.Name) > 100 {
		writeError(w, http.StatusBadRequest, "invalid_name", "Room name must be 1-100 characters")
		return
	}

	if req.MaxUsers == 0 {
		req.MaxUsers = s.config.MaxRoomSize
	}

	// Derive is_public from room_type: 1=public, 2=password-protected, 3=private
	if req.RoomType == 0 {
		req.RoomType = 1 // default to public
	}
	isPublic := req.RoomType != 3

	slug := generateSlug(8)
	settings := RoomSettings{
		IsPublic:  isPublic,
		MaxUsers:  req.MaxUsers,
		AllowChat: true,
		SyncMode:  "strict",
		Password:  req.Password,
		IsAdult:   req.IsAdult,
	}
	settingsJSON, _ := json.Marshal(settings)

	ownerID, _ := extractCallerFromToken(r.Header.Get("Authorization"))

	var expiresAt *time.Time
	if !req.Persistent {
		t := time.Now().Add(24 * time.Hour)
		expiresAt = &t
	}

	var room Room
	err := s.db.QueryRow(context.Background(),
		`INSERT INTO rooms (name, slug, settings, owner_id, expires_at)
		 VALUES ($1, $2, $3, NULLIF($4,'')::uuid, $5)
		 RETURNING id, name, slug, COALESCE(owner_id::text,''), settings, current_state, created_at, expires_at`,
		req.Name, slug, settingsJSON, ownerID, expiresAt,
	).Scan(&room.ID, &room.Name, &room.Slug, &room.OwnerID, &settingsJSON, &room.CurrentState, &room.CreatedAt, &room.ExpiresAt)

	if err != nil {
		log.Printf("Create room error: %v", err)
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to create room")
		return
	}

	json.Unmarshal(settingsJSON, &room.Settings)
	room.RoomType = roomTypeFromSettings(room.Settings)
	room.Settings.Password = "" // never expose password

	s.publishEvent("room.created", map[string]interface{}{
		"room_id":    room.ID,
		"slug":       room.Slug,
		"name":       room.Name,
		"persistent": req.Persistent,
	})
	s.logRoomEvent(room.ID, "room_created", ownerID, "", map[string]interface{}{
		"name":       room.Name,
		"persistent": req.Persistent,
	})

	writeJSON(w, http.StatusCreated, room)
}

// GET /api/v1/rooms/:id  or  /api/v1/rooms (list)
func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// List all public rooms
	if r.URL.Path == "/api/v1/rooms" || r.URL.Path == "/api/v1/rooms/" {
		rows, err := s.db.Query(context.Background(),
			`SELECT id::text, name, slug, settings::text, current_state::text, created_at
			 FROM rooms
			 WHERE settings->>'is_public' = 'true'
			 AND (expires_at IS NULL OR expires_at > NOW())
			 ORDER BY created_at DESC LIMIT 50`,
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to list rooms")
			return
		}
		defer rows.Close()

		rooms := []Room{}
		for rows.Next() {
			var rm Room
			var settingsJSON, stateJSON []byte
			if err := rows.Scan(&rm.ID, &rm.Name, &rm.Slug, &settingsJSON, &stateJSON, &rm.CreatedAt); err != nil {
				continue
			}
			json.Unmarshal(settingsJSON, &rm.Settings)
			json.Unmarshal(stateJSON, &rm.CurrentState)
			rm.RoomType = roomTypeFromSettings(rm.Settings)
			rm.Settings.Password = "" // never expose password
			rooms = append(rooms, rm)
		}
		writeJSON(w, http.StatusOK, rooms)
		return
	}

	// Get single room by ID or slug
	id := extractID(r.URL.Path, "/api/v1/rooms/")

	var room Room
	var settingsJSON, stateJSON []byte
	err := s.db.QueryRow(context.Background(),
		`SELECT id::text, name, slug, COALESCE(owner_id::text,''), COALESCE(video_source,''), COALESCE(video_url,''),
		        settings::text, current_state::text, created_at
		 FROM rooms WHERE id::text = $1 OR slug = $1`,
		id,
	).Scan(&room.ID, &room.Name, &room.Slug, &room.OwnerID, &room.VideoSource, &room.VideoURL,
		&settingsJSON, &stateJSON, &room.CreatedAt)

	if err != nil {
		log.Printf("handleGetRoom scan error for id=%q: %v", id, err)
		writeError(w, http.StatusNotFound, "room_not_found", "Room not found")
		return
	}

	json.Unmarshal(settingsJSON, &room.Settings)
	json.Unmarshal(stateJSON, &room.CurrentState)
	room.RoomType = roomTypeFromSettings(room.Settings)
	room.Settings.Password = ""

	// Attach online user count from Redis
	presenceKey := fmt.Sprintf("room:%s:presence", room.ID)
	count, _ := s.redis.SCard(context.Background(), presenceKey).Result()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"room":         room,
		"online_users": count,
	})
}

// DELETE /api/v1/rooms/:id
func (s *Server) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	callerID, callerIsAdmin := extractCallerFromToken(r.Header.Get("Authorization"))

	id := extractID(r.URL.Path, "/api/v1/rooms/")
	id = strings.TrimSuffix(id, "/")

	// Check ownership unless caller is admin
	if !callerIsAdmin {
		var ownerID string
		err := s.db.QueryRow(context.Background(),
			`SELECT COALESCE(owner_id::text,'') FROM rooms WHERE id::text = $1`, id,
		).Scan(&ownerID)
		if err != nil {
			writeError(w, http.StatusNotFound, "room_not_found", "Room not found")
			return
		}
		if ownerID != "" && ownerID != callerID {
			writeError(w, http.StatusForbidden, "forbidden", "You do not own this room")
			return
		}
	}

	_, err := s.db.Exec(context.Background(), `DELETE FROM rooms WHERE id::text = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to delete room")
		return
	}

	s.publishEvent(fmt.Sprintf("room.%s.deleted", id), map[string]string{"room_id": id})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// POST /api/v1/rooms/:id/join
func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract room ID from path: /api/v1/rooms/:id/join
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 5 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path")
		return
	}
	roomID := parts[4]

	var req JoinRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	var settingsJSON []byte
	var settings RoomSettings
	err := s.db.QueryRow(context.Background(),
		`SELECT settings FROM rooms WHERE id::text = $1 OR slug = $1`, roomID,
	).Scan(&settingsJSON)

	if err != nil {
		writeError(w, http.StatusNotFound, "room_not_found", "Room not found")
		return
	}
	json.Unmarshal(settingsJSON, &settings)

	// Check password
	if settings.Password != "" && settings.Password != req.Password {
		writeError(w, http.StatusForbidden, "wrong_password", "Incorrect room password")
		return
	}

	// 18+ gate: adult rooms require a user who confirmed being 18+.
	if settings.IsAdult {
		var isAdult bool
		err := s.db.QueryRow(context.Background(),
			`SELECT COALESCE(preferences->>'is_adult','false')::boolean FROM users WHERE id = $1`,
			req.UserID,
		).Scan(&isAdult)
		if err != nil || !isAdult {
			writeError(w, http.StatusForbidden, "adult_required", "Эта комната 18+ — подтвердите возраст в профиле")
			return
		}
	}

	// Publish join event for ws-gateway to pick up
	s.publishEvent(fmt.Sprintf("room.%s.joined", roomID), map[string]interface{}{
		"room_id":  roomID,
		"user_id":  req.UserID,
		"username": req.UserName,
	})

	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "joined",
		"room_id": roomID,
	})
}

// POST /api/v1/rooms/:id/invite
func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 5 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path")
		return
	}
	roomID := parts[4]

	code := generateSlug(12)
	expiresAt := time.Now().Add(24 * time.Hour)

	var inviteID string
	err := s.db.QueryRow(context.Background(),
		`INSERT INTO invitations (room_id, code, expires_at)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		roomID, code, expiresAt,
	).Scan(&inviteID)

	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to create invite")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"id":         inviteID,
		"code":       code,
		"expires_at": expiresAt,
	})
}

// GET /api/v1/rooms/:id/events
func (s *Server) handleRoomEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 5 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path")
		return
	}
	roomID := parts[4]

	limit := 100
	rows, err := s.db.Query(context.Background(),
		`SELECT id::text, room_id::text, event_type, COALESCE(user_id,''), COALESCE(username,''),
		        COALESCE(payload::text,'{}'), created_at
		 FROM room_events
		 WHERE room_id = $1::uuid
		 ORDER BY created_at DESC
		 LIMIT $2`,
		roomID, limit,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to fetch events")
		return
	}
	defer rows.Close()

	events := []RoomEvent{}
	for rows.Next() {
		var ev RoomEvent
		var payloadStr string
		if err := rows.Scan(&ev.ID, &ev.RoomID, &ev.EventType, &ev.UserID, &ev.Username, &payloadStr, &ev.CreatedAt); err != nil {
			continue
		}
		ev.Payload = json.RawMessage(payloadStr)
		events = append(events, ev)
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) publishEvent(subject string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.nats.Publish(subject, data)
}

// roomTypeFromSettings computes room_type integer from settings
func roomTypeFromSettings(s RoomSettings) int {
	if !s.IsPublic {
		return 3 // private
	}
	if s.Password != "" {
		return 2 // password-protected
	}
	return 1 // public
}

func generateSlug(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return hex.EncodeToString(b)[:length]
}

func extractID(path, prefix string) string {
	id := strings.TrimPrefix(path, prefix)
	// Remove trailing path segments like /join, /invite
	parts := strings.SplitN(id, "/", 2)
	return parts[0]
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

func main() {
	config := &Config{
		Port:        getEnv("PORT", "8080"),
		DBHost:      getEnv("DB_HOST", "localhost"),
		DBPort:      getEnv("DB_PORT", "5432"),
		DBUser:      getEnv("DB_USER", "watchsync"),
		DBPassword:  getEnv("DB_PASSWORD", "changeme"),
		DBName:      getEnv("DB_NAME", "watchsync"),
		DBSSLMode:   getEnv("DB_SSL_MODE", "disable"),
		RedisHost:   getEnv("REDIS_HOST", "localhost"),
		RedisPort:   getEnv("REDIS_PORT", "6379"),
		NatsURL:     getEnv("NATS_URL", "nats://localhost:4222"),
		MaxRoomSize: 100,
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/rooms", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			server.handleCreateRoom(w, r)
		case http.MethodGet:
			server.handleGetRoom(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/v1/rooms/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasSuffix(path, "/join") {
			server.handleJoinRoom(w, r)
		} else if strings.HasSuffix(path, "/invite") {
			server.handleCreateInvite(w, r)
		} else if strings.HasSuffix(path, "/events") {
			server.handleRoomEvents(w, r)
		} else if r.Method == http.MethodDelete {
			server.handleDeleteRoom(w, r)
		} else {
			server.handleGetRoom(w, r)
		}
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"room-service"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Room service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

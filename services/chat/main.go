package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/gocql/gocql"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Config struct {
	Port               string
	ScyllaHosts        []string
	ScyllaKeyspace     string
	RedisHost          string
	RedisPort          string
	RedisDB            int
	NatsURL            string
	MaxMessageLength   int
	RateLimitMessages  int
	RateLimitWindow    time.Duration
}

type Server struct {
	config  *Config
	scylla  *gocql.Session
	redis   *redis.Client
	nats    *nats.Conn
}

type ChatMessage struct {
	RoomID      string            `json:"room_id"`
	MessageID   string            `json:"message_id"`
	UserID      string            `json:"user_id"`
	Username    string            `json:"username"`
	AvatarURL   string            `json:"avatar_url,omitempty"`
	Content     string            `json:"content"`
	MessageType string            `json:"message_type"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Timestamp   time.Time         `json:"timestamp"`
}

var (
	messagesProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "chat_service_messages_processed_total",
		Help: "Total chat messages processed",
	})
	rateLimitHits = promauto.NewCounter(prometheus.CounterOpts{
		Name: "chat_service_rate_limit_hits_total",
		Help: "Total rate limit hits",
	})
)

func NewServer(cfg *Config) *Server {
	return &Server{config: cfg}
}

func (s *Server) Initialize() error {
	// Connect to ScyllaDB — retry because cluster needs up to 60s to reach consensus
	cluster := gocql.NewCluster(s.config.ScyllaHosts...)
	cluster.Keyspace = s.config.ScyllaKeyspace
	cluster.Consistency = gocql.LocalQuorum
	cluster.Timeout = 30 * time.Second
	cluster.ConnectTimeout = 60 * time.Second
	cluster.RetryPolicy = &gocql.SimpleRetryPolicy{NumRetries: 5}

	var session *gocql.Session
	var scyllaErr error
	for attempt := 1; attempt <= 8; attempt++ {
		session, scyllaErr = cluster.CreateSession()
		if scyllaErr == nil {
			break
		}
		log.Printf("ScyllaDB connection attempt %d/8 failed: %v", attempt, scyllaErr)
		if attempt < 8 {
			time.Sleep(10 * time.Second)
		}
	}
	if scyllaErr != nil {
		return fmt.Errorf("scylla connection failed after 8 attempts: %w", scyllaErr)
	}
	s.scylla = session
	log.Println("Connected to ScyllaDB")

	// Connect to Redis
	s.redis = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:%s", s.config.RedisHost, s.config.RedisPort),
		DB:   s.config.RedisDB,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	// Connect to NATS
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

	// Subscribe to chat messages from ws-gateway
	_, err = nc.Subscribe("room.*.chat", s.handleIncomingMessage)
	if err != nil {
		return fmt.Errorf("nats chat subscription failed: %w", err)
	}

	return nil
}

// handleIncomingMessage processes chat messages from NATS
func (s *Server) handleIncomingMessage(msg *nats.Msg) {
	var wsMsg struct {
		Type      string          `json:"type"`
		Payload   json.RawMessage `json:"payload"`
		UserID    string          `json:"user_id"`
		RoomID    string          `json:"room_id"`
		Timestamp int64           `json:"timestamp"`
	}
	if err := json.Unmarshal(msg.Data, &wsMsg); err != nil {
		log.Printf("Error unmarshaling chat message: %v", err)
		return
	}

	var payload struct {
		Content        string `json:"content"`
		Type           string `json:"type"`
		AttachmentURL  string `json:"attachment_url,omitempty"`
		AttachmentName string `json:"attachment_name,omitempty"`
		AttachmentType string `json:"attachment_type,omitempty"`
	}
	if wsMsg.Payload != nil {
		json.Unmarshal(wsMsg.Payload, &payload)
	}

	if payload.Content == "" && payload.AttachmentURL == "" {
		return
	}
	if wsMsg.RoomID == "" || wsMsg.UserID == "" {
		return
	}

	// Rate limiting
	if !s.checkRateLimit(wsMsg.UserID) {
		log.Printf("Rate limit exceeded for user %s", wsMsg.UserID)
		rateLimitHits.Inc()
		return
	}

	if len(payload.Content) > s.config.MaxMessageLength {
		payload.Content = payload.Content[:s.config.MaxMessageLength]
	}

	if payload.Type == "" {
		if payload.AttachmentURL != "" {
			payload.Type = "attachment"
		} else {
			payload.Type = "text"
		}
	}

	// Persist to ScyllaDB
	msgID := gocql.TimeUUID()
	bucket := time.Now().Truncate(24 * time.Hour)

	metadata := map[string]string{}
	if payload.AttachmentURL != "" {
		metadata["attachment_url"] = payload.AttachmentURL
		metadata["attachment_name"] = payload.AttachmentName
		metadata["attachment_type"] = payload.AttachmentType
	}

	var err error
	if len(metadata) > 0 {
		err = s.scylla.Query(
			`INSERT INTO chat_messages (room_id, bucket, message_id, user_id, username, content, message_type, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			wsMsg.RoomID, bucket, msgID, wsMsg.UserID, wsMsg.UserID, payload.Content, payload.Type, metadata,
		).Exec()
	} else {
		err = s.scylla.Query(
			`INSERT INTO chat_messages (room_id, bucket, message_id, user_id, username, content, message_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			wsMsg.RoomID, bucket, msgID, wsMsg.UserID, wsMsg.UserID, payload.Content, payload.Type,
		).Exec()
	}

	if err != nil {
		log.Printf("ScyllaDB insert error: %v", err)
		return
	}

	messagesProcessed.Inc()
	log.Printf("Chat message persisted for room %s from user %s", wsMsg.RoomID, wsMsg.UserID)
}

// checkRateLimit checks if user is within rate limits
func (s *Server) checkRateLimit(userID string) bool {
	ctx := context.Background()
	key := fmt.Sprintf("ratelimit:chat:%s", userID)

	count, err := s.redis.Incr(ctx, key).Result()
	if err != nil {
		return false // deny on Redis error to prevent rate-limit bypass
	}
	if count == 1 {
		s.redis.Expire(ctx, key, s.config.RateLimitWindow)
	}

	return int(count) <= s.config.RateLimitMessages
}

// GET /api/v1/rooms/:id/messages
func (s *Server) handleGetMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract room ID from /api/v1/rooms/:id/messages
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/rooms/"), "/")
	if len(parts) < 2 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path")
		return
	}
	roomID := parts[0]

	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 200 {
		limit = n
	}

	bucket := time.Now().Truncate(24 * time.Hour)

	iter := s.scylla.Query(
		`SELECT message_id, user_id, username, content, message_type, metadata
		 FROM chat_messages
		 WHERE room_id = ? AND bucket = ?
		 ORDER BY message_id DESC
		 LIMIT ?`,
		roomID, bucket, limit,
	).Iter()

	messages := []ChatMessage{}
	var msgIDStr string
	var userID, username, content, msgType string
	var metadata map[string]string

	for iter.Scan(&msgIDStr, &userID, &username, &content, &msgType, &metadata) {
		msgUUID, err := gocql.ParseUUID(msgIDStr)
		if err != nil {
			continue
		}
		messages = append(messages, ChatMessage{
			RoomID:      roomID,
			MessageID:   msgIDStr,
			UserID:      userID,
			Username:    username,
			Content:     content,
			MessageType: msgType,
			Metadata:    metadata,
			Timestamp:   msgUUID.Time(),
		})
	}

	if err := iter.Close(); err != nil {
		log.Printf("ScyllaDB query error: %v", err)
	}

	writeJSON(w, http.StatusOK, messages)
}

// POST /api/v1/chat/messages — direct HTTP send (for testing/admin)
// PATCH /api/v1/rooms/{roomId}/messages/{messageId}
// Body: {"user_id": "...", "content": "new text"}
func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/rooms/"), "/")
	if len(parts) < 3 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Expected /rooms/{roomId}/messages/{messageId}")
		return
	}
	roomID := parts[0]
	messageIDStr := parts[2]

	msgUUID, err := gocql.ParseUUID(messageIDStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "Invalid message ID")
		return
	}

	var req struct {
		UserID  string `json:"user_id"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Content == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "content is required")
		return
	}
	if len(req.Content) > s.config.MaxMessageLength {
		writeError(w, http.StatusBadRequest, "too_long", "Message exceeds max length")
		return
	}

	bucket := msgUUID.Time().Truncate(24 * time.Hour)

	var authorID string
	if err := s.scylla.Query(
		`SELECT user_id FROM chat_messages WHERE room_id = ? AND bucket = ? AND message_id = ?`,
		roomID, bucket, msgUUID,
	).Scan(&authorID); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Message not found")
		return
	}
	if req.UserID != "" && authorID != req.UserID {
		writeError(w, http.StatusForbidden, "forbidden", "Cannot edit another user's message")
		return
	}

	if err := s.scylla.Query(
		`UPDATE chat_messages SET content = ? WHERE room_id = ? AND bucket = ? AND message_id = ?`,
		req.Content, roomID, bucket, msgUUID,
	).Exec(); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to update message")
		return
	}

	evt, _ := json.Marshal(map[string]any{
		"type":    "message_edited",
		"room_id": roomID,
		"payload": map[string]string{
			"message_id": messageIDStr,
			"room_id":    roomID,
			"content":    req.Content,
		},
	})
	s.nats.Publish(fmt.Sprintf("room.%s.broadcast", roomID), evt)

	writeJSON(w, http.StatusOK, map[string]string{"status": "edited"})
}

// DELETE /api/v1/rooms/{roomId}/messages/{messageId}
// Body: {"user_id": "..."} — caller must be the message author
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/rooms/"), "/")
	if len(parts) < 3 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Expected /rooms/{roomId}/messages/{messageId}")
		return
	}
	roomID := parts[0]
	messageIDStr := parts[2]

	msgUUID, err := gocql.ParseUUID(messageIDStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "Invalid message ID")
		return
	}

	var req struct {
		UserID string `json:"user_id"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	// Derive bucket from TIMEUUID timestamp
	bucket := msgUUID.Time().Truncate(24 * time.Hour)

	// Verify authorship
	var authorID string
	if err := s.scylla.Query(
		`SELECT user_id FROM chat_messages WHERE room_id = ? AND bucket = ? AND message_id = ?`,
		roomID, bucket, msgUUID,
	).Scan(&authorID); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Message not found")
		return
	}
	if req.UserID != "" && authorID != req.UserID {
		writeError(w, http.StatusForbidden, "forbidden", "Cannot delete another user's message")
		return
	}

	if err := s.scylla.Query(
		`DELETE FROM chat_messages WHERE room_id = ? AND bucket = ? AND message_id = ?`,
		roomID, bucket, msgUUID,
	).Exec(); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to delete message")
		return
	}

	// Broadcast deletion event
	evt, _ := json.Marshal(map[string]any{
		"type":    "message_deleted",
		"room_id": roomID,
		"payload": map[string]string{"message_id": messageIDStr, "room_id": roomID},
	})
	s.nats.Publish(fmt.Sprintf("room.%s.broadcast", roomID), evt)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var msg ChatMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	if msg.Content == "" || msg.RoomID == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "room_id and content are required")
		return
	}

	msgID := gocql.TimeUUID()
	bucket := time.Now().Truncate(24 * time.Hour)

	err := s.scylla.Query(
		`INSERT INTO chat_messages (room_id, bucket, message_id, user_id, username, content, message_type)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		msg.RoomID, bucket, msgID, msg.UserID, msg.Username, msg.Content, "text",
	).Exec()

	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to save message")
		return
	}

	msg.MessageID = msgID.String()
	msg.Timestamp = msgID.Time()

	// Broadcast via NATS
	data, _ := json.Marshal(map[string]interface{}{
		"type":    "chat_message",
		"room_id": msg.RoomID,
		"payload": msg,
	})
	s.nats.Publish(fmt.Sprintf("room.%s.broadcast", msg.RoomID), data)

	writeJSON(w, http.StatusCreated, msg)
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

func parseDuration(s, defaultVal string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		d, _ = time.ParseDuration(defaultVal)
	}
	return d
}

func main() {
	scyllaHosts := strings.Split(getEnv("SCYLLA_HOSTS", "localhost:9042"), ",")

	config := &Config{
		Port:              getEnv("PORT", "8080"),
		ScyllaHosts:       scyllaHosts,
		ScyllaKeyspace:    getEnv("SCYLLA_KEYSPACE", "chat"),
		RedisHost:         getEnv("REDIS_HOST", "localhost"),
		RedisPort:         getEnv("REDIS_PORT", "6379"),
		NatsURL:           getEnv("NATS_URL", "nats://localhost:4222"),
		MaxMessageLength:  2000,
		RateLimitMessages: 30,
		RateLimitWindow:   parseDuration(getEnv("RATE_LIMIT_WINDOW", "60s"), "60s"),
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/rooms/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasSuffix(path, "/messages") {
			server.handleGetMessages(w, r)
		} else if strings.Contains(path, "/messages/") {
			switch r.Method {
			case http.MethodDelete:
				server.handleDeleteMessage(w, r)
			case http.MethodPatch:
				server.handleEditMessage(w, r)
			}
		}
	})
	mux.HandleFunc("/api/v1/chat/messages", server.handleSendMessage)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"chat-service"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Chat service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

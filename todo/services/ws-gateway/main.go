package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
)

// Configuration
 type Config struct {
	Port            string        `env:"PORT" envDefault:"8080"`
	WSPath          string        `env:"WS_PATH" envDefault:"/ws"`
	RedisHost       string        `env:"REDIS_HOST" envDefault:"localhost"`
	RedisPort       string        `env:"REDIS_PORT" envDefault:"6379"`
	RedisDB         int           `env:"REDIS_DB" envDefault:"1"`
	NatsURL         string        `env:"NATS_URL" envDefault:"nats://localhost:4222"`
	PingInterval    time.Duration `env:"PING_INTERVAL" envDefault:"30s"`
	PongTimeout     time.Duration `env:"PONG_TIMEOUT" envDefault:"10s"`
	MaxConnections  int           `env:"MAX_CONNECTIONS" envDefault:"100000"`
}

// Message types
 const (
	MsgTypeJoinRoom     = "join_room"
	MsgTypeLeaveRoom    = "leave_room"
	MsgTypeVideoAction  = "video_action"
	MsgTypeChatMessage  = "chat_message"
	MsgTypeReaction     = "reaction"
	MsgTypeStateSync    = "state_sync"
	MsgTypeUserJoined   = "user_joined"
	MsgTypeUserLeft     = "user_left"
	MsgTypeError        = "error"
	MsgTypePing         = "ping"
	MsgTypePong         = "pong"
)

// WSMessage represents a WebSocket message
 type WSMessage struct {
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp int64           `json:"timestamp"`
	UserID    string          `json:"user_id,omitempty"`
	RoomID    string          `json:"room_id,omitempty"`
}

// VideoActionPayload represents video player actions
 type VideoActionPayload struct {
	Action   string  `json:"action"` // play, pause, seek, rate_change
	Time     float64 `json:"time"`
	Rate     float64 `json:"rate,omitempty"`
	Source   string  `json:"source"`
	Version  uint64  `json:"version"`
}

// Client represents a connected WebSocket client
 type Client struct {
	ID       string
	UserID   string
	RoomID   string
	Conn     *websocket.Conn
	Server   *Server
	Send     chan []byte
	mu       sync.RWMutex
}

// Server manages WebSocket connections
 type Server struct {
	config    *Config
	upgrader  websocket.Upgrader
	clients   map[string]*Client // map[clientID]*Client
	rooms     map[string]map[string]*Client // map[roomID]map[clientID]*Client
	redis     *redis.Client
	nats      *nats.Conn
	register  chan *Client
	unregister chan *Client
	broadcast chan *WSMessage
	mu        sync.RWMutex
}

// NewServer creates a new WebSocket server
 func NewServer(cfg *Config) *Server {
	return &Server{
		config: cfg,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Configure for production
			},
		},
		clients:    make(map[string]*Client),
		rooms:      make(map[string]map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan *WSMessage, 256),
	}
}

// Initialize connections
 func (s *Server) Initialize() error {
	// Initialize Redis
	s.redis = redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", s.config.RedisHost, s.config.RedisPort),
		DB:       s.config.RedisDB,
		PoolSize: 100,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := s.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	// Initialize NATS
	nc, err := nats.Connect(s.config.NatsURL)
	if err != nil {
		return fmt.Errorf("nats connection failed: %w", err)
	}
	s.nats = nc
	log.Println("Connected to NATS")

	// Subscribe to room broadcasts
	_, err = nc.Subscribe("room.*.broadcast", func(msg *nats.Msg) {
		var wsMsg WSMessage
		if err := json.Unmarshal(msg.Data, &wsMsg); err != nil {
			log.Printf("Error unmarshaling NATS message: %v", err)
			return
		}
		s.broadcast <- &wsMsg
	})
	if err != nil {
		return fmt.Errorf("nats subscription failed: %w", err)
	}

	return nil
}

// Run starts the server loops
 func (s *Server) Run() {
	go s.handleRegistration()
	go s.handleBroadcast()
}

// handleRegistration handles client registration/unregistration
 func (s *Server) handleRegistration() {
	for {
		select {
		case client := <-s.register:
			s.mu.Lock()
			s.clients[client.ID] = client
			if client.RoomID != "" {
				if s.rooms[client.RoomID] == nil {
					s.rooms[client.RoomID] = make(map[string]*Client)
				}
				s.rooms[client.RoomID][client.ID] = client
			}
			s.mu.Unlock()
			log.Printf("Client registered: %s (Room: %s)", client.ID, client.RoomID)

		case client := <-s.unregister:
			s.mu.Lock()
			if _, ok := s.clients[client.ID]; ok {
				delete(s.clients, client.ID)
				close(client.Send)
				if client.RoomID != "" && s.rooms[client.RoomID] != nil {
					delete(s.rooms[client.RoomID], client.ID)
					if len(s.rooms[client.RoomID]) == 0 {
						delete(s.rooms, client.RoomID)
					}
				}
			}
			s.mu.Unlock()
			log.Printf("Client unregistered: %s", client.ID)
		}
	}
}

// handleBroadcast handles broadcasting messages to rooms
 func (s *Server) handleBroadcast() {
	for msg := range s.broadcast {
		s.mu.RLock()
		roomClients, ok := s.rooms[msg.RoomID]
		s.mu.RUnlock()

		if !ok {
			continue
		}

		data, err := json.Marshal(msg)
		if err != nil {
			log.Printf("Error marshaling message: %v", err)
			continue
		}

		for _, client := range roomClients {
			select {
			case client.Send <- data:
			default:
				// Client send buffer full, close connection
				s.unregister <- client
			}
		}
	}
}

// HandleWebSocket handles WebSocket upgrade and connection
 func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check max connections
	s.mu.RLock()
	clientCount := len(s.clients)
	s.mu.RUnlock()

	if clientCount >= s.config.MaxConnections {
		http.Error(w, "Server at capacity", http.StatusServiceUnavailable)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &Client{
		ID:     generateClientID(),
		Conn:   conn,
		Server: s,
		Send:   make(chan []byte, 256),
	}

	s.register <- client

	// Start goroutines for client
	go client.writePump()
	go client.readPump()
}

// readPump handles incoming messages from client
 func (c *Client) readPump() {
	defer func() {
		c.Server.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadDeadline(time.Now().Add(c.Server.config.PongTimeout))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(c.Server.config.PongTimeout))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Error unmarshaling message: %v", err)
			continue
		}

		msg.UserID = c.UserID
		msg.RoomID = c.RoomID
		msg.Timestamp = time.Now().UnixMilli()

		c.handleMessage(&msg)
	}
}

// writePump handles outgoing messages to client
 func (c *Client) writePump() {
	ticker := time.NewTicker(c.Server.config.PingInterval)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued messages
			n := len(c.Send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleMessage processes incoming messages
 func (c *Client) handleMessage(msg *WSMessage) {
	switch msg.Type {
	case MsgTypeJoinRoom:
		c.handleJoinRoom(msg)
	case MsgTypeLeaveRoom:
		c.handleLeaveRoom(msg)
	case MsgTypeVideoAction:
		c.handleVideoAction(msg)
	case MsgTypeChatMessage:
		c.handleChatMessage(msg)
	case MsgTypeReaction:
		c.handleReaction(msg)
	case MsgTypePing:
		c.handlePing(msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleJoinRoom handles room join requests
 func (c *Client) handleJoinRoom(msg *WSMessage) {
	var payload struct {
		RoomID   string `json:"room_id"`
		UserID   string `json:"user_id"`
		Token    string `json:"token"`
	}

	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		c.sendError("invalid_payload", "Failed to parse join room payload")
		return
	}

	// TODO: Validate token

	c.mu.Lock()
	oldRoom := c.RoomID
	c.RoomID = payload.RoomID
	c.UserID = payload.UserID
	c.mu.Unlock()

	// Remove from old room
	if oldRoom != "" {
		c.Server.mu.Lock()
		if c.Server.rooms[oldRoom] != nil {
			delete(c.Server.rooms[oldRoom], c.ID)
		}
		c.Server.mu.Unlock()

		// Notify old room
		leaveMsg := &WSMessage{
			Type:      MsgTypeUserLeft,
			RoomID:    oldRoom,
			UserID:    c.UserID,
			Timestamp: time.Now().UnixMilli(),
			Payload:   mustJSON(map[string]string{"user_id": c.UserID}),
		}
		c.Server.broadcast <- leaveMsg
	}

	// Add to new room
	c.Server.mu.Lock()
	if c.Server.rooms[c.RoomID] == nil {
		c.Server.rooms[c.RoomID] = make(map[string]*Client)
	}
	c.Server.rooms[c.RoomID][c.ID] = c
	c.Server.mu.Unlock()

	// Store in Redis
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:presence", c.RoomID)
	c.Server.redis.SAdd(ctx, key, c.UserID)
	c.Server.redis.Expire(ctx, key, 24*time.Hour)

	// Notify room
	joinMsg := &WSMessage{
		Type:      MsgTypeUserJoined,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(map[string]string{"user_id": c.UserID}),
	}
	c.Server.broadcast <- joinMsg

	// Send current room state to client
	stateMsg := &WSMessage{
		Type:   MsgTypeStateSync,
		RoomID: c.RoomID,
		Payload: mustJSON(map[string]interface{}{
			"users": c.getRoomUsers(),
		}),
	}
	c.Send <- mustJSONBytes(stateMsg)

	log.Printf("User %s joined room %s", c.UserID, c.RoomID)
}

// handleLeaveRoom handles room leave requests
 func (c *Client) handleLeaveRoom(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}

	c.Server.mu.Lock()
	if c.Server.rooms[c.RoomID] != nil {
		delete(c.Server.rooms[c.RoomID], c.ID)
	}
	c.Server.mu.Unlock()

	// Remove from Redis
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:presence", c.RoomID)
	c.Server.redis.SRem(ctx, key, c.UserID)

	// Notify room
	leaveMsg := &WSMessage{
		Type:      MsgTypeUserLeft,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(map[string]string{"user_id": c.UserID}),
	}
	c.Server.broadcast <- leaveMsg

	c.mu.Lock()
	c.RoomID = ""
	c.mu.Unlock()
}

// handleVideoAction handles video player actions
 func (c *Client) handleVideoAction(msg *WSMessage) {
	if c.RoomID == "" {
		c.sendError("not_in_room", "Not in a room")
		return
	}

	var action VideoActionPayload
	if err := json.Unmarshal(msg.Payload, &action); err != nil {
		c.sendError("invalid_payload", "Failed to parse video action")
		return
	}

	action.Source = c.UserID

	// Store state in Redis
	ctx := context.Background()
	stateKey := fmt.Sprintf("room:%s:video_state", c.RoomID)
	stateData, _ := json.Marshal(action)
	c.Server.redis.Set(ctx, stateKey, stateData, 24*time.Hour)

	// Broadcast to room
	broadcastMsg := &WSMessage{
		Type:      MsgTypeVideoAction,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(action),
	}

	// Publish to NATS for cross-server sync
	data, _ := json.Marshal(broadcastMsg)
	c.Server.nats.Publish(fmt.Sprintf("room.%s.broadcast", c.RoomID), data)

	log.Printf("Video action from %s: %s @ %.2f", c.UserID, action.Action, action.Time)
}

// handleChatMessage handles chat messages
 func (c *Client) handleChatMessage(msg *WSMessage) {
	if c.RoomID == "" {
		c.sendError("not_in_room", "Not in a room")
		return
	}

	// Publish to NATS for chat service processing
	data, _ := json.Marshal(msg)
	c.Server.nats.Publish(fmt.Sprintf("room.%s.chat", c.RoomID), data)

	// Broadcast immediately for real-time feel
	c.Server.broadcast <- msg
}

// handleReaction handles emoji reactions
 func (c *Client) handleReaction(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}
	c.Server.broadcast <- msg
}

// handlePing handles ping messages
 func (c *Client) handlePing(msg *WSMessage) {
	pong := &WSMessage{
		Type:      MsgTypePong,
		Timestamp: time.Now().UnixMilli(),
	}
	c.Send <- mustJSONBytes(pong)
}

// sendError sends an error message to client
 func (c *Client) sendError(code, message string) {
	errMsg := &WSMessage{
		Type: MsgTypeError,
		Payload: mustJSON(map[string]string{
			"code":    code,
			"message": message,
		}),
		Timestamp: time.Now().UnixMilli(),
	}
	c.Send <- mustJSONBytes(errMsg)
}

// getRoomUsers returns list of users in the room
 func (c *Client) getRoomUsers() []string {
	c.Server.mu.RLock()
	defer c.Server.mu.RUnlock()

	room := c.Server.rooms[c.RoomID]
	if room == nil {
		return []string{}
	}

	users := make([]string, 0, len(room))
	seen := make(map[string]bool)
	for _, client := range room {
		if !seen[client.UserID] {
			users = append(users, client.UserID)
			seen[client.UserID] = true
		}
	}
	return users
}

// Helper functions
 func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

 func mustJSON(v interface{}) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

 func mustJSONBytes(v interface{}) []byte {
	data, _ := json.Marshal(v)
	return data
}

 func main() {
	config := &Config{
		Port:           getEnv("PORT", "8080"),
		WSPath:         getEnv("WS_PATH", "/ws"),
		RedisHost:      getEnv("REDIS_HOST", "localhost"),
		RedisPort:      getEnv("REDIS_PORT", "6379"),
		NatsURL:        getEnv("NATS_URL", "nats://localhost:4222"),
		PingInterval:   30 * time.Second,
		PongTimeout:    10 * time.Second,
		MaxConnections: 100000,
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	server.Run()

	// HTTP handlers
	http.HandleFunc(config.WSPath, server.HandleWebSocket)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	// Metrics endpoint
	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		server.mu.RLock()
		stats := map[string]interface{}{
			"connections": len(server.clients),
			"rooms":       len(server.rooms),
		}
		server.mu.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	})

	// Start server
	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("WebSocket server starting on %s", addr)

	go func() {
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Close all connections
	server.mu.Lock()
	for _, client := range server.clients {
		close(client.Send)
		client.Conn.Close()
	}
	server.mu.Unlock()

	// Close Redis
	server.redis.Close()

	// Close NATS
	server.nats.Close()

	log.Println("Server stopped")
}

 func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

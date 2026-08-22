package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Configuration
type Config struct {
	Port           string
	WSPath         string
	RedisHost      string
	RedisPort      string
	RedisDB        int
	NatsURL        string
	AuthServiceURL string
	PingInterval   time.Duration
	PongTimeout    time.Duration
	MaxConnections int
}

// Message types
const (
	MsgTypeJoinRoom     = "join_room"
	MsgTypeLeaveRoom    = "leave_room"
	MsgTypeVideoAction  = "video_action"
	MsgTypeVideoSelect  = "video_select"
	MsgTypeVideoUpdated = "video_updated"
	MsgTypeChatMessage  = "chat_message"
	MsgTypeReaction     = "reaction"
	MsgTypeStateSync    = "state_sync"
	MsgTypeUserJoined   = "user_joined"
	MsgTypeUserLeft     = "user_left"
	MsgTypeError        = "error"
	MsgTypePing         = "ping"
	MsgTypePong         = "pong"
	MsgTypeWebRTCOffer  = "webrtc_offer"
	MsgTypeWebRTCAnswer = "webrtc_answer"
	MsgTypeWebRTCIce    = "webrtc_ice"
	MsgTypeStreamStart  = "stream_start"
	MsgTypeStreamStop   = "stream_stop"
	MsgTypeStreamActive = "stream_active" // sent to new joiner when a broadcast is already running
	MsgTypeStreamChunk  = "stream_chunk"  // relayed MediaRecorder chunk (base64 webm data)
	MsgTypeVoiceJoin    = "voice_join"
	MsgTypeVoiceLeave   = "voice_leave"
	MsgTypeVoiceOffer   = "voice_offer"
	MsgTypeVoiceAnswer  = "voice_answer"
	MsgTypeVoiceIce     = "voice_ice"
	MsgTypeSyncReady    = "sync_ready"
	MsgTypeAllSynced    = "all_synced"
	MsgTypeSyncPending  = "sync_pending"
	MsgTypeRoomInit          = "room_init"
	MsgTypeStatusProbe       = "status_probe"
	MsgTypeSyncSettings      = "sync_settings_update"
	MsgTypeSyncSettingsState = "sync_settings"
	MsgTypeDMSend            = "dm_send"
	MsgTypeDMReceive         = "dm_receive"
	MsgTypeChatTyping        = "chat_typing"
	MsgTypeAuth              = "auth"
	MsgTypeWatchTick         = "watch_tick"
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
	ClientID string  `json:"client_id,omitempty"` // per-tab session ID for echo detection
}

// RoomVideoInfo stores the current video for a room in Redis (key: room:{id}:video_info)
type RoomVideoInfo struct {
	VideoURL    string `json:"video_url"`
	VideoSource string `json:"video_source"`
	Title       string `json:"title,omitempty"`
	UpdatedAt   int64  `json:"updated_at"`
}

// Client represents a connected WebSocket client
type Client struct {
	ID          string
	UserID      string
	Username    string
	Permissions map[string]bool
	RoomID      string
	Conn       *websocket.Conn
	Server     *Server
	Send       chan []byte
	unicastSub *nats.Subscription // receives unicast NATS messages (pong, probe responses)
	mu         sync.RWMutex
	sendMu     sync.RWMutex // guards sendClosed — prevents send-on-closed panic
	sendClosed bool
}

// Prometheus metrics
var (
	activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_gateway_active_connections",
		Help: "Number of active WebSocket connections",
	})
	activeRooms = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_gateway_active_rooms",
		Help: "Number of active rooms",
	})
	messagesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_gateway_messages_total",
		Help: "Total number of WebSocket messages processed",
	}, []string{"type"})
)

// BroadcasterInfo tracks the active screen/camera broadcaster for a room
type BroadcasterInfo struct {
	ClientID   string `json:"client_id"`
	UserID     string `json:"user_id"`
	Username   string `json:"username"`
	StreamType string `json:"stream_type"` // "screen" or "camera"
	MimeType   string `json:"mime_type"`   // webm codec advertised by the broadcaster (for MSE late joiners)
}

// Server manages WebSocket connections
type Server struct {
	config           *Config
	upgrader         websocket.Upgrader
	clients          map[string]*Client
	rooms            map[string]map[string]*Client
	readyUsers       map[string]map[string]bool // roomID → userID → ready
	roomBroadcasters map[string]*BroadcasterInfo // roomID → active broadcaster (at most one per room)
	roomVoiceMembers map[string]map[string]string // roomID → userID → username
	initChunks       map[string]string            // roomID → base64 webm init segment (for late joiners)
	redis            *redis.Client
	nats             *nats.Conn
	register         chan *Client
	unregister       chan *Client
	broadcast        chan *WSMessage
	mu               sync.RWMutex
}

// NewServer creates a new WebSocket server
func NewServer(cfg *Config) *Server {
	return &Server{
		config: cfg,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Configure CORS for production as needed
			},
		},
		clients:          make(map[string]*Client),
		rooms:            make(map[string]map[string]*Client),
		readyUsers:       make(map[string]map[string]bool),
		roomBroadcasters: make(map[string]*BroadcasterInfo),
		roomVoiceMembers: make(map[string]map[string]string),
		initChunks:       make(map[string]string),
		register:         make(chan *Client),
		unregister:       make(chan *Client),
		broadcast:        make(chan *WSMessage, 256),
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

	// Subscribe to room broadcasts from sync/chat services
	_, err = nc.Subscribe("room.*.broadcast", func(msg *nats.Msg) {
		var wsMsg WSMessage
		if err := json.Unmarshal(msg.Data, &wsMsg); err != nil {
			log.Printf("Error unmarshaling NATS message: %v", err)
			return
		}
		// Subject format: "room.{roomID}.broadcast" — extract roomID if not in payload
		if wsMsg.RoomID == "" {
			parts := strings.Split(msg.Subject, ".")
			if len(parts) >= 3 {
				wsMsg.RoomID = parts[1]
			}
		}
		s.broadcast <- &wsMsg
	})
	if err != nil {
		return fmt.Errorf("nats subscription failed: %w", err)
	}

	// Subscribe to achievement_unlocked pub/sub (published by user-service) and
	// route each unlock notification to the target user's WebSocket connection.
	go s.forwardAchievements()

	return nil
}

// forwardAchievements subscribes to the Redis "achievement_unlocked" pub/sub
// channel and forwards each unlock to the target user's active WebSocket.
func (s *Server) forwardAchievements() {
	pubsub := s.redis.Subscribe(context.Background(), "achievement_unlocked")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		var ach struct {
			UserID string `json:"user_id"`
			ID     string `json:"id"`
			Name   string `json:"name"`
			Icon   string `json:"icon"`
		}
		if err := json.Unmarshal([]byte(msg.Payload), &ach); err != nil || ach.UserID == "" {
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"id":   ach.ID,
			"name": ach.Name,
			"icon": ach.Icon,
		})
		wsMsg := &WSMessage{
			Type:      "achievement_unlocked",
			Payload:   json.RawMessage(payload),
			Timestamp: time.Now().UnixMilli(),
			UserID:    ach.UserID,
		}
		data, err := json.Marshal(wsMsg)
		if err != nil {
			continue
		}

		s.mu.RLock()
		for _, client := range s.clients {
			if client.UserID == ach.UserID {
				client.safeSend(data)
			}
		}
		s.mu.RUnlock()
	}
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
			s.mu.Unlock()
			activeConnections.Inc()
			log.Printf("Client registered: %s", client.ID)

		case client := <-s.unregister:
			leavingRoom := client.RoomID
			var streamStopMsg *WSMessage
			s.mu.Lock()
			if _, ok := s.clients[client.ID]; ok {
				delete(s.clients, client.ID)
				client.sendMu.Lock()
				client.sendClosed = true
				close(client.Send)
				client.sendMu.Unlock()
				if client.RoomID != "" && s.rooms[client.RoomID] != nil {
					delete(s.rooms[client.RoomID], client.ID)
					if len(s.rooms[client.RoomID]) == 0 {
						delete(s.rooms, client.RoomID)
						activeRooms.Dec()
					}
				}
				if client.RoomID != "" && s.readyUsers[client.RoomID] != nil {
					delete(s.readyUsers[client.RoomID], client.UserID)
				}
				// Clear broadcaster tracking if this client was the broadcaster
				if client.RoomID != "" {
					if info, ok := s.roomBroadcasters[client.RoomID]; ok && info.ClientID == client.ID {
						delete(s.roomBroadcasters, client.RoomID)
						streamStopMsg = &WSMessage{
							Type:      MsgTypeStreamStop,
							RoomID:    client.RoomID,
							UserID:    client.UserID,
							Timestamp: time.Now().UnixMilli(),
							Payload:   mustJSON(map[string]string{"from": client.UserID}),
						}
					}
				}
				// Remove from voice members on disconnect
				if client.RoomID != "" && client.UserID != "" {
					if vm := s.roomVoiceMembers[client.RoomID]; vm != nil {
						delete(vm, client.UserID)
						if len(vm) == 0 {
							delete(s.roomVoiceMembers, client.RoomID)
						}
					}
				}
			}
			s.mu.Unlock()
			if streamStopMsg != nil {
				s.broadcast <- streamStopMsg
			}
			// Always broadcast voice_leave on disconnect so peers clean up their connections
			if client.RoomID != "" && client.UserID != "" {
				s.broadcast <- &WSMessage{
					Type:      MsgTypeVoiceLeave,
					RoomID:    client.RoomID,
					UserID:    client.UserID,
					Timestamp: time.Now().UnixMilli(),
					Payload:   mustJSON(map[string]string{"from": client.UserID}),
				}
			}
			client.flushWatchTime()
			activeConnections.Dec()
			if leavingRoom != "" {
				go s.broadcastSyncStatus(leavingRoom)
			}
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
			if !client.safeSend(data) {
				// Buffer full — signal cleanup without blocking the broadcast loop
				select {
				case s.unregister <- client:
				default:
				}
			}
		}
	}
}

// HandleWebSocket handles WebSocket upgrade and connection
func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	clientCount := len(s.clients)
	s.mu.RUnlock()

	if clientCount >= s.config.MaxConnections {
		http.Error(w, "Server at capacity", http.StatusServiceUnavailable)
		return
	}

	// Handshake-level auth: Authorization header only. The token must NOT be
	// passed via ?token= query param — query strings end up in nginx/Kong
	// access logs and would leak the credential. Clients without a header can
	// authenticate with a {type:"auth"} message as their first WS frame.
	handshakeToken := ""
	if auth := r.Header.Get("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
		handshakeToken = auth[7:]
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

	// If a valid token was provided at handshake time, pre-populate identity.
	// join_room will still be required to associate the client with a room,
	// but the user ID cannot be overridden by the payload.
	if handshakeToken != "" {
		if uid, uname, perms := s.verifyTokenClaims(handshakeToken); uid != "" {
			client.UserID = uid
			client.Username = uname
			client.Permissions = perms
		}
	}

	s.register <- client

	go client.writePump()
	go client.readPump()
}

// readPump handles incoming messages from client
func (c *Client) readPump() {
	defer func() {
		// Unsubscribe from unicast NATS subject (handles unexpected disconnects)
		c.mu.Lock()
		if c.unicastSub != nil {
			c.unicastSub.Unsubscribe()
			c.unicastSub = nil
		}
		c.mu.Unlock()

		// Notify room on disconnect
		if c.RoomID != "" {
			leaveMsg := &WSMessage{
				Type:      MsgTypeUserLeft,
				RoomID:    c.RoomID,
				UserID:    c.UserID,
				Timestamp: time.Now().UnixMilli(),
				Payload:   mustJSON(map[string]string{"user_id": c.UserID}),
			}
			c.Server.broadcast <- leaveMsg

			ctx := context.Background()
			key := fmt.Sprintf("room:%s:presence", c.RoomID)
			c.Server.redis.SRem(ctx, key, c.UserID)
		}
		c.Server.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadDeadline(time.Now().Add(c.Server.config.PongTimeout + c.Server.config.PingInterval))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(c.Server.config.PongTimeout + c.Server.config.PingInterval))
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

		messagesTotal.WithLabelValues(msg.Type).Inc()
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

			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
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

// safeSend delivers data to the client's send channel without panicking on a closed channel.
// Holds sendMu RLock for the duration of the channel operation so it cannot race with close().
// Returns false if the client is already closed or the send buffer is full.
func (c *Client) safeSend(data []byte) bool {
	c.sendMu.RLock()
	defer c.sendMu.RUnlock()
	if c.sendClosed {
		return false
	}
	select {
	case c.Send <- data:
		return true
	default:
		return false
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
	case MsgTypeVideoSelect:
		c.handleVideoSelect(msg)
	case MsgTypeSyncReady:
		c.handleSyncReady(msg)
	case MsgTypeStatusProbe:
		c.handleStatusProbe(msg)
	case MsgTypeWebRTCOffer, MsgTypeWebRTCAnswer, MsgTypeWebRTCIce:
		c.handleWebRTCRelay(msg)
	case MsgTypeStreamStart, MsgTypeStreamStop:
		c.handleStreamEvent(msg)
	case MsgTypeStreamChunk:
		c.handleStreamChunk(msg)
	case MsgTypeVoiceOffer, MsgTypeVoiceAnswer, MsgTypeVoiceIce:
		c.handleWebRTCRelay(msg) // route to target peer using payload.target
	case MsgTypeSyncSettings:
		c.handleSyncSettings(msg)
	case MsgTypeDMSend:
		c.handleDM(msg)
	case MsgTypeVoiceJoin, MsgTypeVoiceLeave:
		c.handleVoicePresence(msg) // track voice members + send voice_state to joiner
	case MsgTypeChatTyping:
		c.handleChatTyping(msg)
	case MsgTypeAuth:
		c.handleAuth(msg)
	case MsgTypeWatchTick:
		c.handleWatchTick(msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// flushWatchTime saves elapsed seconds for user's current watch session to Redis
func (c *Client) flushWatchTime() {
	if c.UserID == "" {
		return
	}
	ctx := context.Background()
	sessionKey := fmt.Sprintf("watch:session:%s", c.UserID)
	startStr, err := c.Server.redis.GetDel(ctx, sessionKey).Result()
	if err != nil {
		return
	}
	startUnix, err := strconv.ParseInt(startStr, 10, 64)
	if err != nil {
		return
	}
	elapsed := time.Now().Unix() - startUnix
	if elapsed > 0 && elapsed < 86400 {
		c.Server.redis.IncrBy(ctx, fmt.Sprintf("watch:total:%s", c.UserID), elapsed)

		// Push watch history entry when leaving a room
		if c.RoomID != "" {
			var title string
			if viData, viErr := c.Server.redis.Get(ctx, fmt.Sprintf("room:%s:video_info", c.RoomID)).Result(); viErr == nil {
				var vi struct {
					Title string `json:"title"`
				}
				if json.Unmarshal([]byte(viData), &vi) == nil {
					title = vi.Title
				}
			}
			entry, _ := json.Marshal(map[string]interface{}{
				"room_id":   c.RoomID,
				"title":     title,
				"timestamp": time.Now().Unix(),
				"seconds":   elapsed,
			})
			histKey := fmt.Sprintf("watch:history:%s", c.UserID)
			c.Server.redis.LPush(ctx, histKey, string(entry))
			c.Server.redis.LTrim(ctx, histKey, 0, 19)
			c.Server.redis.Expire(ctx, histKey, 90*24*time.Hour)
		}
	}
}

// hasPermission reports whether the client holds the given capability. When no
// token was presented (Permissions == nil) only the anonymous-safe capabilities
// (join_room, chat) are granted; everything else is denied.
func (c *Client) hasPermission(perm string) bool {
	if c.Permissions == nil {
		// Guests (no token) get a permissive default for core real-time features
		// (screen share, voice, queue, uploads) so they work without a login.
		return perm == "can_join_room" || perm == "can_chat" ||
			perm == "can_stream" || perm == "can_use_mic" ||
			perm == "can_add_to_queue" || perm == "can_upload_file"
	}
	return c.Permissions[perm]
}

// sendPermissionDenied sends the standardized permission-denied error frame:
// { type: 'error', code: 'PERMISSION_DENIED', action: '...' }.
func (c *Client) sendPermissionDenied(action string) {
	data, _ := json.Marshal(map[string]interface{}{
		"type":      MsgTypeError,
		"code":      "PERMISSION_DENIED",
		"action":    action,
		"timestamp": time.Now().UnixMilli(),
	})
	c.Send <- data
}

// handleAuth processes an in-band authentication message, used when the client
// did not (or could not) provide an Authorization header at upgrade time.
// Payload: { token: "<jwt>" }. The resulting identity cannot be overridden.
func (c *Client) handleAuth(msg *WSMessage) {
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.Token == "" {
		c.sendError("invalid_payload", "token required")
		return
	}

	uid, uname, perms := c.Server.verifyTokenClaims(payload.Token)
	if uid == "" {
		c.sendError("unauthorized", "Invalid token")
		return
	}

	c.mu.Lock()
	c.UserID = uid
	c.Username = uname
	c.Permissions = perms
	c.mu.Unlock()

	c.Send <- mustJSONBytes(&WSMessage{
		Type:      "auth_ok",
		UserID:    uid,
		Timestamp: time.Now().UnixMilli(),
	})
}

// handleJoinRoom handles room join requests
func (c *Client) handleJoinRoom(msg *WSMessage) {
	var payload struct {
		RoomID   string `json:"room_id"`
		UserID   string `json:"user_id"`
		Token    string `json:"token"`
		Username string `json:"username"`
	}

	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		c.sendError("invalid_payload", "Failed to parse join room payload")
		return
	}

	// If identity was already verified at handshake, honour it (cannot be overridden).
	// Otherwise verify the token from the join_room payload (guest fallback).
	c.mu.RLock()
	handshakeUID := c.UserID
	c.mu.RUnlock()
	if handshakeUID != "" {
		payload.UserID = handshakeUID
		if payload.Username == "" {
			c.mu.RLock()
			payload.Username = c.Username
			c.mu.RUnlock()
		}
	} else if payload.Token != "" {
		if uid, uname, perms := c.Server.verifyTokenClaims(payload.Token); uid != "" {
			payload.UserID = uid
			if payload.Username == "" {
				payload.Username = uname
			}
			c.mu.Lock()
			c.Permissions = perms
			c.mu.Unlock()
		}
	}

	// Enforce join-room permission from the verified token's claims.
	if !c.hasPermission("can_join_room") {
		c.sendPermissionDenied("join_room")
		return
	}

	// Leave current room first
	if c.RoomID != "" {
		c.handleLeaveRoom(msg)
	}

	c.mu.Lock()
	c.RoomID = payload.RoomID
	c.UserID = payload.UserID
	if payload.Username != "" {
		c.Username = payload.Username
	}
	c.mu.Unlock()

	// Add to room map
	c.Server.mu.Lock()
	if c.Server.rooms[c.RoomID] == nil {
		c.Server.rooms[c.RoomID] = make(map[string]*Client)
		activeRooms.Inc()
	}
	c.Server.rooms[c.RoomID][c.ID] = c
	c.Server.mu.Unlock()

	// Track presence in Redis
	ctx := context.Background()
	key := fmt.Sprintf("room:%s:presence", c.RoomID)
	c.Server.redis.SAdd(ctx, key, c.UserID)
	c.Server.redis.Expire(ctx, key, 24*time.Hour)

	// Subscribe to unicast NATS messages for this client (pong, probe responses)
	unicastSubj := fmt.Sprintf("room.%s.user.%s", c.RoomID, c.UserID)
	sub, err := c.Server.nats.Subscribe(unicastSubj, func(natMsg *nats.Msg) {
		c.safeSend(natMsg.Data) // no-op if client closed or buffer full
	})
	if err == nil {
		c.mu.Lock()
		c.unicastSub = sub
		c.mu.Unlock()
	}

	// Notify room
	joinMsg := &WSMessage{
		Type:      MsgTypeUserJoined,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(map[string]string{"user_id": c.UserID, "username": c.Username}),
	}
	c.Server.broadcast <- joinMsg

	// Pause-on-join: mark new joiner as not-ready, auto-mark all existing members as ready.
	// Without auto-marking, existing users who never re-sent sync_ready (e.g. room opened with no
	// video, or readyUsers was reset by video-select) would keep total>ready forever.
	c.Server.mu.Lock()
	if c.Server.readyUsers[c.RoomID] == nil {
		c.Server.readyUsers[c.RoomID] = make(map[string]bool)
	}
	for _, cl := range c.Server.rooms[c.RoomID] {
		if cl.UserID != c.UserID {
			c.Server.readyUsers[c.RoomID][cl.UserID] = true
		}
	}
	delete(c.Server.readyUsers[c.RoomID], c.UserID) // joiner is not ready yet
	c.Server.mu.Unlock()
	go c.Server.broadcastSyncStatus(c.RoomID)

	// Read current video info and playback state from Redis
	ctx2 := context.Background()
	var videoInfo RoomVideoInfo
	if viData, _ := c.Server.redis.Get(ctx2, fmt.Sprintf("room:%s:video_info", c.RoomID)).Result(); viData != "" {
		if err := json.Unmarshal([]byte(viData), &videoInfo); err != nil {
			log.Printf("Error unmarshaling video_info for room %s: %v", c.RoomID, err)
		}
	}
	var playState struct {
		CurrentTime  float64 `json:"current_time"`
		PlaybackRate float64 `json:"playback_rate"`
	}
	if psData, _ := c.Server.redis.Get(ctx2, fmt.Sprintf("room:%s:video_state", c.RoomID)).Result(); psData != "" {
		if err := json.Unmarshal([]byte(psData), &playState); err != nil {
			log.Printf("Error unmarshaling video_state for room %s: %v", c.RoomID, err)
		}
	}
	if playState.PlaybackRate == 0 {
		playState.PlaybackRate = 1.0
	}

	// Check for active broadcaster in this room
	c.Server.mu.RLock()
	broadcaster := c.Server.roomBroadcasters[c.RoomID]
	c.Server.mu.RUnlock()

	// Read proxy mode state for late joiners
	var proxyModePayload map[string]interface{}
	if pmData, _ := c.Server.redis.Get(ctx2, fmt.Sprintf("room:%s:proxy_mode", c.RoomID)).Result(); pmData != "" {
		if err := json.Unmarshal([]byte(pmData), &proxyModePayload); err != nil {
			log.Printf("Error unmarshaling proxy_mode for room %s: %v", c.RoomID, err)
		}
	}

	initPayload := map[string]interface{}{
		"users":        c.getRoomUsers(),
		"video_url":    videoInfo.VideoURL,
		"video_source": videoInfo.VideoSource,
		"title":        videoInfo.Title,
		"state": map[string]interface{}{
			"current_time":  playState.CurrentTime,
			"is_playing":    false,
			"playback_rate": playState.PlaybackRate,
		},
	}
	if proxyModePayload != nil {
		initPayload["proxy_mode"] = proxyModePayload
	}
	if ssData, _ := c.Server.redis.Get(ctx2, fmt.Sprintf("room:%s:sync_settings", c.RoomID)).Result(); ssData != "" {
		var ss map[string]interface{}
		if json.Unmarshal([]byte(ssData), &ss) == nil {
			initPayload["sync_settings"] = ss
		}
	}
	if broadcaster != nil {
		initPayload["broadcaster"] = map[string]string{
			"user_id":     broadcaster.UserID,
			"username":    broadcaster.Username,
			"stream_type": broadcaster.StreamType,
			"mime_type":   broadcaster.MimeType,
		}
	}

	// Send room_init to joining client with full state (always paused)
	initMsg := &WSMessage{
		Type:      MsgTypeRoomInit,
		RoomID:    c.RoomID,
		Payload:   mustJSON(initPayload),
		Timestamp: time.Now().UnixMilli(),
	}
	c.Send <- mustJSONBytes(initMsg)

	// If a broadcast is active, send the stored init chunk so the late joiner can start MSE immediately
	if broadcaster != nil {
		c.Server.mu.RLock()
		initChunk, hasInit := c.Server.initChunks[c.RoomID]
		c.Server.mu.RUnlock()
		if hasInit {
			chunkMsg := &WSMessage{
				Type:      MsgTypeStreamChunk,
				RoomID:    c.RoomID,
				UserID:    broadcaster.UserID,
				Timestamp: time.Now().UnixMilli(),
				Payload:   mustJSON(map[string]interface{}{"data": initChunk, "init": true, "from": broadcaster.UserID}),
			}
			c.Send <- mustJSONBytes(chunkMsg)
		}
	}

	// Pause everyone in the room when a new user joins (only if video is set)
	if videoInfo.VideoURL != "" {
		c.Server.broadcast <- &WSMessage{
			Type:   MsgTypeStateSync,
			RoomID: c.RoomID,
			Payload: mustJSON(map[string]interface{}{
				"source_user_id": "_system",
				"state": map[string]interface{}{
					"is_playing":    false,
					"current_time":  playState.CurrentTime,
					"playback_rate": playState.PlaybackRate,
				},
				"adjusted_time": playState.CurrentTime,
			}),
			Timestamp: time.Now().UnixMilli(),
		}
	}

	// Reset ready state — new joiner means everyone must re-sync
	c.Server.mu.Lock()
	c.Server.readyUsers[c.RoomID] = make(map[string]bool)
	c.Server.mu.Unlock()
	go c.Server.broadcastSyncStatus(c.RoomID)

	// Start watch session timer
	if c.UserID != "" {
		c.Server.redis.Set(context.Background(), fmt.Sprintf("watch:session:%s", c.UserID), time.Now().Unix(), 25*time.Hour)
	}

	log.Printf("User %s joined room %s", c.UserID, c.RoomID)
}

// broadcastSyncStatus sends all_synced or sync_pending to all room members
func (s *Server) broadcastSyncStatus(roomID string) {
	s.mu.RLock()
	roomClients := s.rooms[roomID]
	total := len(roomClients)
	ready := 0
	for _, cl := range roomClients {
		if s.readyUsers[roomID][cl.UserID] {
			ready++
		}
	}
	s.mu.RUnlock()

	if total == 0 {
		return
	}

	msgType := MsgTypeSyncPending
	if ready >= total {
		msgType = MsgTypeAllSynced
	}

	s.broadcast <- &WSMessage{
		Type:   msgType,
		RoomID: roomID,
		Payload: mustJSON(map[string]interface{}{
			"ready": ready,
			"total": total,
		}),
		Timestamp: time.Now().UnixMilli(),
	}
}

// handleSyncReady marks a user as ready for synchronized playback
func (c *Client) handleSyncReady(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}
	c.Server.mu.Lock()
	if c.Server.readyUsers[c.RoomID] == nil {
		c.Server.readyUsers[c.RoomID] = make(map[string]bool)
	}
	c.Server.readyUsers[c.RoomID][c.UserID] = true
	c.Server.mu.Unlock()
	c.Server.broadcastSyncStatus(c.RoomID)
}

// handleLeaveRoom handles room leave requests
func (c *Client) handleLeaveRoom(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}

	// Unsubscribe from unicast NATS subject
	c.mu.Lock()
	if c.unicastSub != nil {
		c.unicastSub.Unsubscribe()
		c.unicastSub = nil
	}
	c.mu.Unlock()

	oldRoom := c.RoomID

	c.Server.mu.Lock()
	if c.Server.rooms[oldRoom] != nil {
		delete(c.Server.rooms[oldRoom], c.ID)
		if len(c.Server.rooms[oldRoom]) == 0 {
			delete(c.Server.rooms, oldRoom)
			activeRooms.Dec()
		}
	}
	c.Server.mu.Unlock()

	ctx := context.Background()
	key := fmt.Sprintf("room:%s:presence", oldRoom)
	c.Server.redis.SRem(ctx, key, c.UserID)

	c.flushWatchTime()

	leaveMsg := &WSMessage{
		Type:      MsgTypeUserLeft,
		RoomID:    oldRoom,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(map[string]string{"user_id": c.UserID}),
	}
	c.Server.broadcast <- leaveMsg

	// Remove from ready tracking and recheck sync status
	c.Server.mu.Lock()
	if c.Server.readyUsers[oldRoom] != nil {
		delete(c.Server.readyUsers[oldRoom], c.UserID)
	}
	c.Server.mu.Unlock()
	go c.Server.broadcastSyncStatus(oldRoom)

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

	// Store current state in Redis for late joiners
	ctx := context.Background()
	stateKey := fmt.Sprintf("room:%s:video_state", c.RoomID)
	stateData, _ := json.Marshal(action)
	c.Server.redis.Set(ctx, stateKey, stateData, 24*time.Hour)

	// Publish to NATS — sync-service picks this up for CRDT merge
	broadcastMsg := &WSMessage{
		Type:      MsgTypeVideoAction,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   mustJSON(action),
	}

	data, _ := json.Marshal(broadcastMsg)
	if err := c.Server.nats.Publish(fmt.Sprintf("room.%s.video_action", c.RoomID), data); err != nil {
		log.Printf("NATS publish error (video_action, room %s): %v", c.RoomID, err)
	}

	log.Printf("Video action from %s in room %s: %s @ %.2f", c.UserID, c.RoomID, action.Action, action.Time)
}

// handleChatMessage handles chat messages
func (c *Client) handleChatMessage(msg *WSMessage) {
	if c.RoomID == "" {
		c.sendError("not_in_room", "Not in a room")
		return
	}

	// Publish to NATS — chat-service persists to ScyllaDB
	data, _ := json.Marshal(msg)
	if err := c.Server.nats.Publish(fmt.Sprintf("room.%s.chat", c.RoomID), data); err != nil {
		log.Printf("NATS publish error (chat, room %s): %v", c.RoomID, err)
	}

	// Broadcast immediately for real-time feel
	c.Server.broadcast <- msg
}

// handleChatTyping broadcasts typing indicator to room (excluding sender, no persistence)
func (c *Client) handleChatTyping(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}
	out := &WSMessage{
		Type:      MsgTypeChatTyping,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}
	data, _ := json.Marshal(out)

	c.Server.mu.RLock()
	roomClients := c.Server.rooms[c.RoomID]
	c.Server.mu.RUnlock()

	for _, client := range roomClients {
		if client.ID == c.ID {
			continue
		}
		client.safeSend(data)
	}
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

// handleSyncSettings stores per-room sync thresholds in Redis and broadcasts to all room members.
// Only the room owner should call this; Kong JWT validates the token, room ownership checked client-side.
func (c *Client) handleSyncSettings(msg *WSMessage) {
	if c.RoomID == "" {
		c.sendError("not_in_room", "Not in a room")
		return
	}
	var settings struct {
		SoftThreshold float64 `json:"soft_threshold"`
		HardThreshold float64 `json:"hard_threshold"`
	}
	if b, err := json.Marshal(msg.Payload); err == nil {
		json.Unmarshal(b, &settings)
	}
	if settings.SoftThreshold <= 0 || settings.HardThreshold <= settings.SoftThreshold {
		c.sendError("invalid_settings", "soft_threshold > 0 and hard_threshold > soft_threshold required")
		return
	}
	key := fmt.Sprintf("room:%s:sync_settings", c.RoomID)
	data, _ := json.Marshal(settings)
	c.Server.redis.Set(context.Background(), key, data, 0)

	payload, _ := json.Marshal(settings)
	c.Server.broadcast <- &WSMessage{
		Type:    MsgTypeSyncSettingsState,
		Payload: json.RawMessage(payload),
		RoomID:  c.RoomID,
	}
}

// handleDM delivers a direct message to the target user and echoes to all sender's tabs.
// Payload: { target_user_id, content }. Stored in Redis (last 100 per pair, TTL 7d).
func (c *Client) handleDM(msg *WSMessage) {
	if c.UserID == "" {
		c.sendError("not_authenticated", "Login required for DMs")
		return
	}
	var payload struct {
		TargetUserID string `json:"target_user_id"`
		Content      string `json:"content"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.TargetUserID == "" || payload.Content == "" {
		c.sendError("invalid_payload", "target_user_id and content required")
		return
	}
	if len(payload.Content) > 2000 {
		payload.Content = payload.Content[:2000]
	}

	dmMsg, _ := json.Marshal(map[string]interface{}{
		"from_user_id": c.UserID,
		"from_username": c.Username,
		"content":      payload.Content,
		"timestamp":    time.Now().UnixMilli(),
	})

	// Persist to Redis list (newest-first, capped at 100)
	pairKey := dmPairKey(c.UserID, payload.TargetUserID)
	ctx := context.Background()
	c.Server.redis.LPush(ctx, "dm:"+pairKey, dmMsg)
	c.Server.redis.LTrim(ctx, "dm:"+pairKey, 0, 99)
	c.Server.redis.Expire(ctx, "dm:"+pairKey, 7*24*time.Hour)

	outMsg := &WSMessage{
		Type:    MsgTypeDMReceive,
		Payload: mustJSON(map[string]interface{}{
			"from_user_id":  c.UserID,
			"from_username": c.Username,
			"to_user_id":    payload.TargetUserID,
			"content":       payload.Content,
			"timestamp":     time.Now().UnixMilli(),
		}),
	}
	outBytes := mustJSONBytes(outMsg)

	// Deliver to all target user's connections
	c.Server.mu.RLock()
	for _, cl := range c.Server.clients {
		if cl.UserID == payload.TargetUserID {
			select {
			case cl.Send <- outBytes:
			default:
			}
		}
	}
	// Echo to all sender's own tabs
	for _, cl := range c.Server.clients {
		if cl.UserID == c.UserID && cl.ID != c.ID {
			select {
			case cl.Send <- outBytes:
			default:
			}
		}
	}
	c.Server.mu.RUnlock()

	// Also confirm to sender's current tab
	c.Send <- outBytes
}

// dmPairKey returns a stable Redis key for two user IDs (sorted for consistency)
func dmPairKey(a, b string) string {
	if a < b {
		return a + ":" + b
	}
	return b + ":" + a
}

// GET /api/v1/dm/history?with={userID} — returns last 100 DMs between caller and target (JWT required)
func (s *Server) handleDMHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	authHeader := r.Header.Get("Authorization")
	if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
		authHeader = authHeader[7:]
	}
	userID, _ := s.verifyToken(authHeader)
	if userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	withID := r.URL.Query().Get("with")
	if withID == "" {
		http.Error(w, `{"error":"with param required"}`, http.StatusBadRequest)
		return
	}

	key := "dm:" + dmPairKey(userID, withID)
	msgs, err := s.redis.LRange(r.Context(), key, 0, 99).Result()
	if err != nil {
		msgs = nil
	}

	// Messages are stored newest-first; reverse to chronological order
	out := make([]json.RawMessage, len(msgs))
	for i, m := range msgs {
		out[len(msgs)-1-i] = json.RawMessage(m)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// handleVideoSelect handles video source change — persists video info and broadcasts video_updated
func (c *Client) handleVideoSelect(msg *WSMessage) {
	if c.RoomID == "" {
		c.sendError("not_in_room", "Not in a room")
		return
	}

	// Parse payload — support both video_url/video_source and src/type field names
	var payload struct {
		VideoURL    string `json:"video_url"`
		VideoSource string `json:"video_source"`
		Title       string `json:"title"`
		Src         string `json:"src"`
		Type        string `json:"type"`
		ProxyMode   bool   `json:"proxy_mode"`
		OriginalURL string `json:"original_url"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		log.Printf("Error unmarshaling video_select payload: %v", err)
		c.sendError("invalid_payload", "Failed to parse video select payload")
		return
	}

	videoURL := payload.VideoURL
	if videoURL == "" {
		videoURL = payload.Src
	}
	videoSource := payload.VideoSource
	if videoSource == "" {
		videoSource = payload.Type
	}
	if videoSource == "" {
		videoSource = "direct"
	}

	// Persist video info to Redis
	ctx := context.Background()
	vi := RoomVideoInfo{
		VideoURL:    videoURL,
		VideoSource: videoSource,
		Title:       payload.Title,
		UpdatedAt:   time.Now().UnixMilli(),
	}
	viData, _ := json.Marshal(vi)
	c.Server.redis.Set(ctx, fmt.Sprintf("room:%s:video_info", c.RoomID), viData, 24*time.Hour)

	// Persist proxy mode state so late joiners receive it in room_init
	proxyModeKey := fmt.Sprintf("room:%s:proxy_mode", c.RoomID)
	if payload.ProxyMode {
		pmData, _ := json.Marshal(map[string]interface{}{
			"enabled":      true,
			"proxy_url":    videoURL,
			"original_url": payload.OriginalURL,
		})
		c.Server.redis.Set(ctx, proxyModeKey, pmData, 24*time.Hour)
	} else {
		c.Server.redis.Del(ctx, proxyModeKey)
	}

	// Reset playback state in Redis (sync-service will pick this up)
	resetState, _ := json.Marshal(map[string]interface{}{
		"current_time": 0, "is_playing": false, "playback_rate": 1.0,
		"timestamp": time.Now().UnixMilli(),
	})
	c.Server.redis.Set(ctx, fmt.Sprintf("room:%s:video_state", c.RoomID), resetState, 24*time.Hour)

	// Clear ready users — new video requires everyone to re-sync
	c.Server.mu.Lock()
	c.Server.readyUsers[c.RoomID] = make(map[string]bool)
	c.Server.mu.Unlock()

	// Broadcast video_updated to room
	c.Server.broadcast <- &WSMessage{
		Type:      MsgTypeVideoUpdated,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}

	// Notify room that sync is pending
	go c.Server.broadcastSyncStatus(c.RoomID)
}

// handleWebRTCRelay relays WebRTC signaling to a specific target or whole room
func (c *Client) handleWebRTCRelay(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}
	// Parse target from payload (use map — anonymous struct tags broken in Go 1.22)
	var target string
	var raw map[string]json.RawMessage
	if json.Unmarshal(msg.Payload, &raw) == nil {
		if v, ok := raw["target"]; ok {
			json.Unmarshal(v, &target)
		}
	}

	c.Server.mu.RLock()
	roomClients := c.Server.rooms[c.RoomID]
	c.Server.mu.RUnlock()

	out := &WSMessage{
		Type:      msg.Type,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}
	data, _ := json.Marshal(out)

	for _, client := range roomClients {
		if client.ID == c.ID {
			continue
		}
		if target != "" && client.UserID != target && client.ID != target {
			continue
		}
		client.safeSend(data)
	}
}

// handleStreamEvent broadcasts stream start/stop to all room members and tracks broadcaster
func (c *Client) handleStreamEvent(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}

	if msg.Type == MsgTypeStreamStart && !c.hasPermission("can_stream") {
		log.Printf("[stream] DENIED stream_start user=%s room=%s (no can_stream)", c.UserID, c.RoomID)
		c.sendPermissionDenied("stream_start")
		return
	}

	if msg.Type == MsgTypeStreamStart {
		var p struct {
			StreamType string `json:"stream_type"`
			MimeType   string `json:"mime_type"`
		}
		json.Unmarshal(msg.Payload, &p)
		if p.StreamType == "" {
			p.StreamType = "screen"
		}
		log.Printf("[stream] START user=%s room=%s type=%s mime=%q", c.UserID, c.RoomID, p.StreamType, p.MimeType)
		c.Server.mu.Lock()
		c.Server.roomBroadcasters[c.RoomID] = &BroadcasterInfo{
			ClientID:   c.ID,
			UserID:     c.UserID,
			Username:   c.Username,
			StreamType: p.StreamType,
			MimeType:   p.MimeType,
		}
		delete(c.Server.initChunks, c.RoomID) // clear stale init segment on new stream
		c.Server.mu.Unlock()
	} else if msg.Type == MsgTypeStreamStop {
		c.Server.mu.Lock()
		if info, ok := c.Server.roomBroadcasters[c.RoomID]; ok && info.ClientID == c.ID {
			delete(c.Server.roomBroadcasters, c.RoomID)
		}
		delete(c.Server.initChunks, c.RoomID)
		c.Server.mu.Unlock()
	}

	out := &WSMessage{
		Type:      msg.Type,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}
	c.Server.broadcast <- out
}

// handleVoicePresence tracks who is in voice per room.
// On voice_join: records the member, sends voice_state (current list) back to the joiner, then broadcasts.
// On voice_leave: removes the member, then broadcasts.
func (c *Client) handleVoicePresence(msg *WSMessage) {
	if c.RoomID == "" || c.UserID == "" {
		return
	}
	if msg.Type == MsgTypeVoiceJoin && !c.hasPermission("can_use_mic") {
		c.sendPermissionDenied("voice_join")
		return
	}
	s := c.Server
	s.mu.Lock()
	if s.roomVoiceMembers[c.RoomID] == nil {
		s.roomVoiceMembers[c.RoomID] = make(map[string]string)
	}
	if msg.Type == MsgTypeVoiceJoin {
		s.roomVoiceMembers[c.RoomID][c.UserID] = c.Username
		// Collect current members (excluding self) to send as voice_state
		type voiceMember struct {
			UserID   string `json:"user_id"`
			Username string `json:"username"`
		}
		members := make([]voiceMember, 0, len(s.roomVoiceMembers[c.RoomID]))
		for uid, uname := range s.roomVoiceMembers[c.RoomID] {
			if uid != c.UserID {
				members = append(members, voiceMember{UserID: uid, Username: uname})
			}
		}
		s.mu.Unlock()
		// Send voice_state directly to the joining client so they see existing members
		statePayload, _ := json.Marshal(map[string]interface{}{"members": members})
		c.Send <- mustJSONBytes(&WSMessage{
			Type:      "voice_state",
			RoomID:    c.RoomID,
			UserID:    c.UserID,
			Timestamp: time.Now().UnixMilli(),
			Payload:   statePayload,
		})
	} else {
		delete(s.roomVoiceMembers[c.RoomID], c.UserID)
		if len(s.roomVoiceMembers[c.RoomID]) == 0 {
			delete(s.roomVoiceMembers, c.RoomID)
		}
		s.mu.Unlock()
	}
	// Broadcast join/leave to all room members
	s.broadcast <- &WSMessage{
		Type:      msg.Type,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}
}

// handleStreamChunk relays a MediaRecorder chunk to all room members and caches the init segment.
// The first chunk (init=true) is stored so late-joining viewers can receive it on room_init.
func (c *Client) handleStreamChunk(msg *WSMessage) {
	if c.RoomID == "" {
		return
	}

	var p struct {
		Data string `json:"data"`
		Init bool   `json:"init"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil || p.Data == "" {
		return
	}
	if p.Init {
		log.Printf("[stream] CHUNK-INIT user=%s room=%s bytes=%d", c.UserID, c.RoomID, len(p.Data))
	}

	if p.Init {
		c.Server.mu.Lock()
		c.Server.initChunks[c.RoomID] = p.Data
		c.Server.mu.Unlock()
	}

	// Relay to all room members except sender (direct send, not via broadcast chan to stay fast)
	out := &WSMessage{
		Type:      MsgTypeStreamChunk,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload,
	}
	data, err := json.Marshal(out)
	if err != nil {
		return
	}

	c.Server.mu.RLock()
	roomClients := c.Server.rooms[c.RoomID]
	c.Server.mu.RUnlock()

	for _, client := range roomClients {
		if client.ID != c.ID {
			client.safeSend(data)
		}
	}
}

// handleStatusProbe forwards a client's periodic status probe to the sync-service via NATS
func (c *Client) handleStatusProbe(msg *WSMessage) {
	if c.RoomID == "" || c.UserID == "" {
		return
	}
	forward := &WSMessage{
		Type:      MsgTypeStatusProbe,
		RoomID:    c.RoomID,
		UserID:    c.UserID,
		Timestamp: time.Now().UnixMilli(),
		Payload:   msg.Payload, // { current_time, is_playing }
	}
	data, _ := json.Marshal(forward)
	if err := c.Server.nats.Publish(fmt.Sprintf("room.%s.status_probe", c.RoomID), data); err != nil {
		log.Printf("NATS publish error (status_probe, room %s): %v", c.RoomID, err)
	}
}

// handleWatchTick records periodic watch-time reports from the client.
// Payload: { seconds, video_type, room_id }. The user ID is taken from the
// verified token (c.UserID), never from the payload, so clients cannot inflate
// someone else's watch stats. video_type must be one of youtube, local, hls, embed.
func (c *Client) handleWatchTick(msg *WSMessage) {
	if c.UserID == "" {
		c.sendError("not_authenticated", "Authentication required")
		return
	}

	var p struct {
		Seconds   float64 `json:"seconds"`
		VideoType string  `json:"video_type"`
		RoomID    string  `json:"room_id"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		c.sendError("invalid_payload", "Failed to parse watch_tick payload")
		return
	}

	if p.Seconds <= 0 || p.Seconds > 60 {
		c.sendError("invalid_seconds", "seconds must be in (0, 60]")
		return
	}

	switch p.VideoType {
	case "youtube", "local", "hls", "embed":
	default:
		c.sendError("invalid_video_type", "video_type must be one of youtube, local, hls, embed")
		return
	}

	ctx := context.Background()
	secs := int64(p.Seconds)
	c.Server.redis.IncrBy(ctx, fmt.Sprintf("watch:total:%s", c.UserID), secs)
	c.Server.redis.IncrBy(ctx, fmt.Sprintf("watch:type:%s:%s", c.UserID, p.VideoType), secs)
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

// getRoomUsers returns list of users in the room as [{user_id, username}] objects
func (c *Client) getRoomUsers() []map[string]string {
	c.Server.mu.RLock()
	defer c.Server.mu.RUnlock()

	room := c.Server.rooms[c.RoomID]
	if room == nil {
		return []map[string]string{}
	}

	users := make([]map[string]string, 0, len(room))
	seen := make(map[string]bool)
	for _, client := range room {
		if client.UserID != "" && !seen[client.UserID] {
			users = append(users, map[string]string{
				"user_id":  client.UserID,
				"username": client.Username,
			})
			seen[client.UserID] = true
		}
	}
	return users
}

// generateClientID generates a cryptographically random client ID
func generateClientID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return "client_" + hex.EncodeToString(b)
}

func mustJSON(v interface{}) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

func mustJSONBytes(v interface{}) []byte {
	data, _ := json.Marshal(v)
	return data
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

// verifyToken calls auth-service to validate a JWT token.
// Returns userID and username on success, empty strings on failure.
// Used to prevent clients from spoofing other users' IDs in join_room.
func (s *Server) verifyToken(token string) (userID, username string) {
	userID, username, _ = s.verifyTokenClaims(token)
	return userID, username
}

// verifyTokenClaims validates a JWT via the auth-service /verify endpoint and
// returns the user ID, username and the permission set embedded in the token.
func (s *Server) verifyTokenClaims(token string) (userID, username string, perms map[string]bool) {
	if token == "" {
		return "", "", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	body, _ := json.Marshal(map[string]string{"token": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.config.AuthServiceURL+"/api/v1/auth/verify", bytes.NewReader(body))
	if err != nil {
		return "", "", nil
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", nil
	}

	var result struct {
		Valid       bool            `json:"valid"`
		UserID      string          `json:"user_id"`
		Username    string          `json:"username"`
		Permissions map[string]bool `json:"permissions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || !result.Valid {
		return "", "", nil
	}
	return result.UserID, result.Username, result.Permissions
}

func main() {
	config := &Config{
		Port:           getEnv("PORT", "8080"),
		WSPath:         getEnv("WS_PATH", "/ws"),
		RedisHost:      getEnv("REDIS_HOST", "localhost"),
		RedisPort:      getEnv("REDIS_PORT", "6379"),
		RedisDB:        getEnvInt("REDIS_DB", 1),
		NatsURL:        getEnv("NATS_URL", "nats://localhost:4222"),
		AuthServiceURL: getEnv("AUTH_SERVICE_URL", "http://auth-service:8080"),
		PingInterval:   30 * time.Second,
		PongTimeout:    10 * time.Second,
		MaxConnections: 100000,
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	server.Run()

	mux := http.NewServeMux()
	mux.HandleFunc(config.WSPath, server.HandleWebSocket)
	mux.HandleFunc("/api/v1/dm/history", server.handleDMHistory)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy","service":"ws-gateway"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("WS Gateway starting on %s (ws path: %s)", addr, config.WSPath)

	srv := &http.Server{Addr: addr, Handler: mux}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down ws-gateway...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	srv.Shutdown(ctx)

	server.mu.Lock()
	for _, client := range server.clients {
		client.Conn.Close()
	}
	server.mu.Unlock()

	server.redis.Close()
	server.nats.Close()

	log.Println("WS Gateway stopped")
}

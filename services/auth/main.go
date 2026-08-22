package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/go-redis/redis/v8"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/crypto/bcrypt"
)

// dockerClient communicates with the Docker daemon via Unix socket (no SDK required).
var dockerClient = &http.Client{
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return net.Dial("unix", "/var/run/docker.sock")
		},
	},
	Timeout: 10 * time.Second,
}

type Config struct {
	Port          string
	DBHost        string
	DBPort        string
	DBUser        string
	DBPassword    string
	DBName        string
	DBSSLMode     string
	JWTSecret     string
	JWTAccessTTL  time.Duration
	JWTRefreshTTL time.Duration
	RedisHost     string
	RedisPort     string
	RedisDB       int
	BcryptCost    int
	SMTPHost      string
	SMTPPort      string
	SMTPUser      string
	SMTPPass      string
	SMTPFrom                string
	FrontendURL             string
	EmailVerifyTimeoutDays  int // 0 = disabled; N = block login if email unverified after N days
	DockerProxyInternalOnly bool // restrict /admin/docker/* to localhost/internal IPs
}

type Server struct {
	config      *Config
	db          *pgxpool.Pool
	redis       *redis.Client
	vapidPriv   string
	vapidPub    string
}

// JWT claims
type Claims struct {
	UserID      string          `json:"user_id"`
	Username    string          `json:"username"`
	IsAdmin     bool            `json:"is_admin"`
	Permissions map[string]bool `json:"permissions,omitempty"`
	jwt.RegisteredClaims
}

// Request/Response types
type RegisterRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
	IsAdult  bool   `json:"is_adult"` // user confirms being 18+
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type AuthResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	UserID       string `json:"user_id"`
	Username     string `json:"username"`
}

type UserResponse struct {
	ID               string          `json:"id"`
	Username         string          `json:"username"`
	Email            string          `json:"email,omitempty"`
	EmailVerified    bool            `json:"email_verified"`
	AvatarURL        string          `json:"avatar_url,omitempty"`
	SubscriptionTier string          `json:"subscription_tier"`
	IsAdmin          bool            `json:"is_admin"`
	Permissions      map[string]bool `json:"permissions,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	TotpEnabled      bool            `json:"totp_enabled"`
	TotpRequired     bool            `json:"totp_required"`
	Preferences      map[string]any  `json:"preferences,omitempty"` // safe subset (totp_secret stripped)
}

func NewServer(cfg *Config) *Server {
	return &Server{config: cfg}
}

// ── Permission groups ────────────────────────────────────────────────────────

// PermissionGroup is the API shape for the admin group-management endpoints.
type PermissionGroup struct {
	ID                 string          `json:"id"`
	Name               string          `json:"name"`
	IsGlobal           bool            `json:"is_global"`
	IsAnonymousDefault bool            `json:"is_anonymous_default"`
	Permissions        map[string]bool `json:"permissions"`
}

// permissionKeys is the canonical set of capability keys used across the platform.
var permissionKeys = []string{
	"can_join_room", "can_chat", "can_add_to_queue", "can_use_mic",
	"can_stream", "can_upload_file", "can_create_room", "can_use_proxy", "can_invite",
}

// defaultRegisteredPermissions is the Go-side fallback for the 'registered' group
// (mirrors the SQL seed in init/postgres/08_permissions.sql).
var defaultRegisteredPermissions = map[string]bool{
	"can_join_room": true, "can_chat": true, "can_add_to_queue": true,
	"can_use_mic": true, "can_stream": true, "can_upload_file": true,
	"can_create_room": true, "can_use_proxy": true, "can_invite": true,
}

// defaultAnonymousPermissions is the Go-side fallback for the 'anonymous' group.
var defaultAnonymousPermissions = map[string]bool{
	"can_join_room": true, "can_chat": true, "can_add_to_queue": false,
	"can_use_mic": false, "can_stream": false, "can_upload_file": false,
	"can_create_room": false, "can_use_proxy": false, "can_invite": false,
}

func clonePerms(src map[string]bool) map[string]bool {
	out := make(map[string]bool, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// parsePermissions decodes a JSONB permissions object, falling back to
// registered defaults on any malformed input.
func parsePermissions(data []byte) map[string]bool {
	var m map[string]bool
	if err := json.Unmarshal(data, &m); err != nil || m == nil {
		return clonePerms(defaultRegisteredPermissions)
	}
	return m
}

// normalizePermissions fills any missing capability keys with `false` so every
// group has a complete, deterministic permission set.
func normalizePermissions(in map[string]bool) map[string]bool {
	out := make(map[string]bool, len(permissionKeys))
	for _, k := range permissionKeys {
		out[k] = in[k]
	}
	return out
}

// resolvePermissions computes the effective permission set for a user:
//   1. explicit users.permission_group_id assignment
//   2. anonymous users → 'anonymous' group
//   3. everyone else → 'registered' group
func (s *Server) resolvePermissions(ctx context.Context, userID string) map[string]bool {
	var groupID string
	var prefsJSON []byte
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(permission_group_id::text, ''), COALESCE(preferences, '{}'::jsonb)
		 FROM users WHERE id = $1`,
		userID,
	).Scan(&groupID, &prefsJSON)
	if err != nil {
		// Unknown user (or DB hiccup) — fail safe to registered defaults.
		return clonePerms(defaultRegisteredPermissions)
	}

	if groupID != "" {
		return s.groupPermissionsByID(ctx, groupID)
	}

	// No explicit group: distinguish anonymous users via their preferences.
	var prefs map[string]interface{}
	if json.Unmarshal(prefsJSON, &prefs) == nil {
		if isAnon, _ := prefs["is_anonymous"].(bool); isAnon {
			return s.groupPermissionsByName(ctx, "anonymous")
		}
	}
	return s.groupPermissionsByName(ctx, "registered")
}

func (s *Server) groupPermissionsByID(ctx context.Context, id string) map[string]bool {
	var permsJSON []byte
	if err := s.db.QueryRow(ctx,
		`SELECT permissions FROM permission_groups WHERE id = $1`, id,
	).Scan(&permsJSON); err != nil {
		return clonePerms(defaultRegisteredPermissions)
	}
	return parsePermissions(permsJSON)
}

func (s *Server) groupPermissionsByName(ctx context.Context, name string) map[string]bool {
	var permsJSON []byte
	if err := s.db.QueryRow(ctx,
		`SELECT permissions FROM permission_groups WHERE name = $1`, name,
	).Scan(&permsJSON); err != nil {
		if name == "anonymous" {
			return clonePerms(defaultAnonymousPermissions)
		}
		return clonePerms(defaultRegisteredPermissions)
	}
	return parsePermissions(permsJSON)
}

func (s *Server) Initialize() error {
	// Connect to PostgreSQL — retry up to 5 times to tolerate slow Postgres startup
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

	// Auto-migrate: add email_verified column if it doesn't exist (idempotent)
	s.db.Exec(context.Background(), `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`)

	// Seed default admin user if no users exist
	s.seedAdmin()

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

	// Load or generate VAPID key pair for Web Push
	s.vapidPriv, _ = s.redis.Get(context.Background(), "vapid:private_key").Result()
	s.vapidPub, _ = s.redis.Get(context.Background(), "vapid:public_key").Result()
	if s.vapidPriv == "" || s.vapidPub == "" {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			log.Printf("VAPID key generation failed: %v", err)
		} else {
			s.vapidPriv = priv
			s.vapidPub = pub
			s.redis.Set(context.Background(), "vapid:private_key", priv, 0)
			s.redis.Set(context.Background(), "vapid:public_key", pub, 0)
			log.Println("VAPID keys generated and stored")
		}
	} else {
		log.Println("VAPID keys loaded from Redis")
	}

	return nil
}

// GET /api/v1/push/vapid-key — public VAPID key for push subscription
func (s *Server) handleVAPIDKey(w http.ResponseWriter, r *http.Request) {
	if s.vapidPub == "" {
		writeError(w, http.StatusServiceUnavailable, "vapid_unavailable", "Push notifications not configured")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"public_key": s.vapidPub})
}

// POST /api/v1/push/subscribe — store push subscription for authenticated user
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		s.handlePushUnsubscribe(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
		return
	}

	var sub webpush.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil || sub.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "invalid_subscription", "Invalid push subscription")
		return
	}

	data, _ := json.Marshal(sub)
	key := fmt.Sprintf("push:sub:%s", claims.UserID)
	s.redis.Set(context.Background(), key, data, 0)
	// Also add to global set for broadcast
	s.redis.SAdd(context.Background(), "push:subscribers", claims.UserID)

	writeJSON(w, http.StatusOK, map[string]string{"status": "subscribed"})
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	claims, err := s.verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
		return
	}
	s.redis.Del(context.Background(), fmt.Sprintf("push:sub:%s", claims.UserID))
	s.redis.SRem(context.Background(), "push:subscribers", claims.UserID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "unsubscribed"})
}

// POST /api/v1/auth/admin/broadcast — send message to all push subscribers (admin only)
func (s *Server) handleAdminBroadcast(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.verifyJWT(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin required")
		return
	}

	var req struct {
		Title   string `json:"title"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "message required")
		return
	}

	payload, _ := json.Marshal(map[string]string{
		"title":   req.Title,
		"message": req.Message,
	})

	go s.broadcastPush(string(payload))
	writeJSON(w, http.StatusOK, map[string]string{"status": "broadcast_sent"})
}

func (s *Server) broadcastPush(payload string) {
	if s.vapidPriv == "" {
		return
	}
	ctx := context.Background()
	userIDs, err := s.redis.SMembers(ctx, "push:subscribers").Result()
	if err != nil {
		return
	}
	sent := 0
	for _, uid := range userIDs {
		subData, err := s.redis.Get(ctx, fmt.Sprintf("push:sub:%s", uid)).Result()
		if err != nil {
			continue
		}
		var sub webpush.Subscription
		if err := json.Unmarshal([]byte(subData), &sub); err != nil {
			continue
		}
		resp, err := webpush.SendNotification([]byte(payload), &sub, &webpush.Options{
			VAPIDPublicKey:  s.vapidPub,
			VAPIDPrivateKey: s.vapidPriv,
			TTL:             86400,
			Subscriber:      "mailto:admin@watchsync.local",
		})
		if err != nil {
			log.Printf("Push send error for user %s: %v", uid, err)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == 410 || resp.StatusCode == 404 {
			// Subscription expired — remove
			s.redis.Del(ctx, fmt.Sprintf("push:sub:%s", uid))
			s.redis.SRem(ctx, "push:subscribers", uid)
		}
		sent++
	}
	log.Printf("Push broadcast sent to %d/%d subscribers", sent, len(userIDs))
}

// verifyJWT extracts and validates JWT from Authorization header
func (s *Server) verifyJWT(r *http.Request) (*Claims, error) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return nil, fmt.Errorf("missing token")
	}
	tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(s.config.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	claims, ok := token.Claims.(*Claims)
	if !ok {
		return nil, fmt.Errorf("invalid claims")
	}
	if s.isTokenBlacklisted(claims) {
		return nil, fmt.Errorf("token revoked")
	}
	return claims, nil
}

func (s *Server) seedAdmin() {
	var count int
	err := s.db.QueryRow(context.Background(), "SELECT COUNT(*) FROM users").Scan(&count)
	if err != nil || count > 0 {
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("admin"), s.config.BcryptCost)
	if err != nil {
		log.Printf("seedAdmin: bcrypt error: %v", err)
		return
	}
	_, err = s.db.Exec(context.Background(),
		`INSERT INTO users (username, email, password_hash, subscription_tier)
		 VALUES ('admin', 'admin@localhost', $1, 'admin')`,
		string(hash),
	)
	if err != nil {
		log.Printf("seedAdmin: insert error: %v", err)
		return
	}
	log.Println("Created default admin user: admin / admin")
}

// POST /api/v1/auth/register
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	if len(req.Username) < 3 || len(req.Username) > 32 {
		writeError(w, http.StatusBadRequest, "invalid_username", "Username must be 3-32 characters")
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "weak_password", "Password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), s.config.BcryptCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash_error", "Failed to hash password")
		return
	}

	var userID string
	err = s.db.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password_hash, preferences)
		 VALUES ($1, NULLIF($2,''), $3, CASE WHEN $4 THEN '{"is_adult":true}'::jsonb ELSE '{}'::jsonb END)
		 RETURNING id`,
		req.Username, req.Email, string(hash), req.IsAdult,
	).Scan(&userID)

	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			writeError(w, http.StatusConflict, "user_exists", "Username or email already taken")
			return
		}
		log.Printf("Register error: %v", err)
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to create user")
		return
	}

	accessToken, refreshToken, err := s.generateTokens(userID, req.Username, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
		return
	}

	s.storeRefreshToken(userID, refreshToken)

	// Send verification email asynchronously — non-blocking, failure is silently logged
	if req.Email != "" {
		go s.sendVerificationEmail(userID, req.Username, req.Email)
	}

	writeJSON(w, http.StatusCreated, AuthResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserID:       userID,
		Username:     req.Username,
	})
}

// ── 2FA / TOTP ────────────────────────────────────────────────────────────────

// POST /api/v1/auth/totp/setup — generate TOTP secret and return QR URI (not yet enabled)
// Supports both the logged-in flow (JWT) and the forced-setup flow (temp_token from login).
func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var userID, username string

	var req struct {
		TempToken string `json:"temp_token"`
	}
	if body, err := io.ReadAll(r.Body); err == nil {
		json.Unmarshal(body, &req)
	}

	if req.TempToken != "" {
		// Forced-setup: identity comes from the temp token (user isn't logged in yet).
		dataStr, err := s.redis.Get(r.Context(), fmt.Sprintf("totp:setup:%s", req.TempToken)).Result()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid or expired temp token")
			return
		}
		var pending struct {
			UserID   string `json:"user_id"`
			Username string `json:"username"`
			IsAdmin  bool   `json:"is_admin"`
		}
		if err := json.Unmarshal([]byte(dataStr), &pending); err != nil {
			writeError(w, http.StatusInternalServerError, "parse_error", "Failed to parse pending setup")
			return
		}
		userID, username = pending.UserID, pending.Username
	} else {
		claims, err := s.verifyJWT(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
			return
		}
		userID, username = claims.UserID, claims.Username
	}

	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "WatchSync",
		AccountName: username,
		Algorithm:   otp.AlgorithmSHA1,
		Digits:      otp.DigitsSix,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "totp_error", "Failed to generate TOTP")
		return
	}

	// Store pending secret in Redis (not yet active — activated only after verify)
	s.redis.Set(r.Context(), fmt.Sprintf("totp:pending:%s", userID), key.Secret(), 10*time.Minute)

	writeJSON(w, http.StatusOK, map[string]string{
		"secret": key.Secret(),
		"qr_url": key.URL(),
	})
}

// POST /api/v1/auth/totp/enable — verify code against pending secret and persist.
// In the forced-setup flow (temp_token present) this also completes the login and
// returns full auth tokens.
func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Code      string `json:"code"`
		TempToken string `json:"temp_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "code required")
		return
	}

	forced := req.TempToken != ""
	var userID string

	if forced {
		dataStr, err := s.redis.Get(r.Context(), fmt.Sprintf("totp:setup:%s", req.TempToken)).Result()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid or expired temp token")
			return
		}
		var pending struct {
			UserID   string `json:"user_id"`
			Username string `json:"username"`
			IsAdmin  bool   `json:"is_admin"`
		}
		if err := json.Unmarshal([]byte(dataStr), &pending); err != nil {
			writeError(w, http.StatusInternalServerError, "parse_error", "Failed to parse pending setup")
			return
		}
		userID = pending.UserID
	} else {
		claims, err := s.verifyJWT(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
			return
		}
		userID = claims.UserID
	}

	pendingKey := fmt.Sprintf("totp:pending:%s", userID)
	secret, err := s.redis.Get(r.Context(), pendingKey).Result()
	if err != nil {
		writeError(w, http.StatusBadRequest, "no_pending_setup", "No pending TOTP setup; call /totp/setup first")
		return
	}

	if !totp.Validate(req.Code, secret) {
		writeError(w, http.StatusBadRequest, "invalid_code", "Invalid TOTP code")
		return
	}

	// Persist secret and clear any admin-enforced requirement flag.
	s.db.Exec(r.Context(),
		`UPDATE users SET preferences = (COALESCE(preferences,'{}'::jsonb) || jsonb_build_object('totp_secret', $1::text)) - 'totp_required' WHERE id = $2`,
		secret, userID)
	s.redis.Del(r.Context(), pendingKey)

	if forced {
		// Complete the login: issue full tokens for the now-authenticated user.
		s.redis.Del(r.Context(), fmt.Sprintf("totp:setup:%s", req.TempToken))
		var username string
		var isAdmin bool
		_ = s.db.QueryRow(r.Context(),
			`SELECT username, (subscription_tier = 'admin' OR COALESCE(preferences->>'is_admin','false')::boolean) FROM users WHERE id = $1`,
			userID).Scan(&username, &isAdmin)

		accessToken, refreshToken, err := s.generateTokens(userID, username, isAdmin)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
			return
		}
		s.storeRefreshToken(userID, refreshToken)
		s.db.Exec(r.Context(), `UPDATE users SET last_seen = NOW() WHERE id = $1`, userID)

		writeJSON(w, http.StatusOK, AuthResponse{
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			UserID:       userID,
			Username:     username,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "totp_enabled"})
}

// POST /api/v1/auth/totp/disable — disable 2FA (requires valid TOTP code)
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
		return
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "code required")
		return
	}

	var prefsJSON []byte
	s.db.QueryRow(r.Context(), `SELECT preferences FROM users WHERE id = $1`, claims.UserID).Scan(&prefsJSON)
	var prefs map[string]interface{}
	json.Unmarshal(prefsJSON, &prefs)
	secret, _ := prefs["totp_secret"].(string)
	if secret == "" {
		writeError(w, http.StatusBadRequest, "totp_not_enabled", "2FA is not enabled")
		return
	}

	if !totp.Validate(req.Code, secret) {
		writeError(w, http.StatusBadRequest, "invalid_code", "Invalid TOTP code")
		return
	}

	s.db.Exec(r.Context(), `UPDATE users SET preferences = preferences - 'totp_secret' WHERE id = $1`, claims.UserID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "totp_disabled"})
}

// POST /api/v1/auth/totp/verify — second step of login when totp_required
func (s *Server) handleTOTPVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TempToken string `json:"temp_token"`
		Code      string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" || req.TempToken == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "temp_token and code required")
		return
	}

	// Validate temp token from Redis
	pendingKey := fmt.Sprintf("totp:login:%s", req.TempToken)
	dataStr, err := s.redis.Get(r.Context(), pendingKey).Result()
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid or expired temp token")
		return
	}

	var pending struct {
		UserID      string `json:"user_id"`
		Username    string `json:"username"`
		IsAdmin     bool   `json:"is_admin"`
		TOTPSecret  string `json:"totp_secret"`
	}
	if err := json.Unmarshal([]byte(dataStr), &pending); err != nil {
		writeError(w, http.StatusInternalServerError, "parse_error", "Failed to parse pending login")
		return
	}

	if !totp.Validate(req.Code, pending.TOTPSecret) {
		writeError(w, http.StatusUnauthorized, "invalid_code", "Invalid TOTP code")
		return
	}

	s.redis.Del(r.Context(), pendingKey)

	accessToken, refreshToken, err := s.generateTokens(pending.UserID, pending.Username, pending.IsAdmin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
		return
	}
	s.storeRefreshToken(pending.UserID, refreshToken)
	s.db.Exec(r.Context(), `UPDATE users SET last_seen = NOW() WHERE id = $1`, pending.UserID)

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserID:       pending.UserID,
		Username:     pending.Username,
	})
}

// POST /api/v1/auth/anonymous — create a one-time anonymous session (no PII stored)
// Returns tokens + anon_token (raw secret). Client must persist anon_token to re-login
// via normal /login with username=<returned username> and password=<anon_token>.
func (s *Server) handleAnonymousLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 32-byte random token used as password (stored hashed)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "rng_error", "Failed to generate token")
		return
	}
	anonToken := hex.EncodeToString(tokenBytes)

	// 4-byte random suffix for username
	suffixBytes := make([]byte, 4)
	rand.Read(suffixBytes)
	username := "anon_" + hex.EncodeToString(suffixBytes)

	hash, err := bcrypt.GenerateFromPassword([]byte(anonToken), s.config.BcryptCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash_error", "Failed to hash token")
		return
	}

	var userID string
	err = s.db.QueryRow(context.Background(),
		`INSERT INTO users (username, password_hash, preferences)
		 VALUES ($1, $2, '{"is_anonymous":true}')
		 RETURNING id`,
		username, string(hash),
	).Scan(&userID)
	if err != nil {
		log.Printf("Anonymous register error: %v", err)
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to create anonymous user")
		return
	}

	accessToken, refreshToken, err := s.generateTokens(userID, username, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
		return
	}
	s.storeRefreshToken(userID, refreshToken)

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"user_id":       userID,
		"username":      username,
		"anon_token":    anonToken,
		"is_anonymous":  true,
	})
}

// POST /api/v1/auth/login
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	var userID, passwordHash, username string
	var isAdmin bool
	var prefsJSON []byte
	err := s.db.QueryRow(context.Background(),
		`SELECT id, username, password_hash,
		        (subscription_tier = 'admin' OR COALESCE(preferences->>'is_admin', 'false')::boolean),
		        preferences
		 FROM users WHERE username = $1`,
		req.Username,
	).Scan(&userID, &username, &passwordHash, &isAdmin, &prefsJSON)

	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Invalid username or password")
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Invalid username or password")
		return
	}

	// Block login if email is unverified past the grace period (EMAIL_VERIFY_TIMEOUT_DAYS, 0=disabled)
	if s.config.EmailVerifyTimeoutDays > 0 {
		var email string
		var emailVerified bool
		var createdAt time.Time
		_ = s.db.QueryRow(context.Background(),
			`SELECT COALESCE(email,''), COALESCE(email_verified,false), created_at FROM users WHERE id = $1`, userID,
		).Scan(&email, &emailVerified, &createdAt)
		if email != "" && !emailVerified && time.Since(createdAt) >= time.Duration(s.config.EmailVerifyTimeoutDays)*24*time.Hour {
			writeError(w, http.StatusForbidden, "email_not_verified",
				fmt.Sprintf("Please verify your email address. Accounts must be verified within %d days of registration.", s.config.EmailVerifyTimeoutDays))
			return
		}
	}

	// Check if TOTP is enabled
	var prefs map[string]interface{}
	json.Unmarshal(prefsJSON, &prefs)
	totpSecret, _ := prefs["totp_secret"].(string)
	if totpSecret != "" {
		// Issue a short-lived temp token; client must complete TOTP step
		tempToken := hex.EncodeToString(func() []byte { b := make([]byte, 16); rand.Read(b); return b }())
		pending, _ := json.Marshal(map[string]interface{}{
			"user_id":     userID,
			"username":    username,
			"is_admin":    isAdmin,
			"totp_secret": totpSecret,
		})
		s.redis.Set(context.Background(), fmt.Sprintf("totp:login:%s", tempToken), pending, 5*time.Minute)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"totp_required": true,
			"temp_token":    tempToken,
		})
		return
	}

	// Admin-enforced 2FA: user must set up TOTP before they can log in.
	if req2FA, _ := prefs["totp_required"].(bool); req2FA {
		tempToken := hex.EncodeToString(func() []byte { b := make([]byte, 16); rand.Read(b); return b }())
		pending, _ := json.Marshal(map[string]interface{}{
			"user_id":  userID,
			"username": username,
			"is_admin": isAdmin,
		})
		s.redis.Set(context.Background(), fmt.Sprintf("totp:setup:%s", tempToken), pending, 10*time.Minute)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"totp_setup_required": true,
			"temp_token":          tempToken,
		})
		return
	}

	// Update last_seen
	s.db.Exec(context.Background(), `UPDATE users SET last_seen = NOW() WHERE id = $1`, userID)

	accessToken, refreshToken, err := s.generateTokens(userID, username, isAdmin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
		return
	}

	s.storeRefreshToken(userID, refreshToken)

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserID:       userID,
		Username:     username,
	})
}

// GET /api/v1/auth/me
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims, err := s.extractClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid or expired token")
		return
	}

	var user UserResponse
	var prefsJSON []byte
	err = s.db.QueryRow(context.Background(),
		`SELECT id, username, COALESCE(email,''), COALESCE(email_verified,false), COALESCE(avatar_url,''), subscription_tier, created_at, COALESCE(preferences,'{}'::jsonb)
		 FROM users WHERE id = $1`,
		claims.UserID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.EmailVerified, &user.AvatarURL, &user.SubscriptionTier, &user.CreatedAt, &prefsJSON)

	if err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	var prefs map[string]interface{}
	if json.Unmarshal(prefsJSON, &prefs) == nil {
		secret, _ := prefs["totp_secret"].(string)
		user.TotpEnabled = secret != ""
		req2FA, _ := prefs["totp_required"].(bool)
		user.TotpRequired = req2FA
		// Expose a safe subset of preferences to the client (is_adult, theme,
		// badge, status, privacy, ...) — strip the TOTP secret.
		delete(prefs, "totp_secret")
		delete(prefs, "totp_required")
		if len(prefs) > 0 {
			user.Preferences = prefs
		}
	}

	user.IsAdmin = user.SubscriptionTier == "admin"
	user.Permissions = s.resolvePermissions(r.Context(), claims.UserID)
	writeJSON(w, http.StatusOK, user)
}

// POST /api/v1/auth/refresh
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "refresh_token required")
		return
	}

	claims, err := s.validateToken(body.RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid refresh token")
		return
	}

	// Check token is in Redis (not invalidated)
	ctx := context.Background()
	key := fmt.Sprintf("refresh:%s", claims.UserID)
	stored, err := s.redis.Get(ctx, key).Result()
	if err != nil || stored != body.RefreshToken {
		writeError(w, http.StatusUnauthorized, "token_revoked", "Refresh token has been revoked")
		return
	}

	accessToken, refreshToken, err := s.generateTokens(claims.UserID, claims.Username, claims.IsAdmin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token_error", "Failed to generate tokens")
		return
	}

	s.storeRefreshToken(claims.UserID, refreshToken)

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserID:       claims.UserID,
		Username:     claims.Username,
	})
}

// POST /api/v1/auth/logout
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims, err := s.extractClaims(r)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	ctx := context.Background()
	s.redis.Del(ctx, fmt.Sprintf("refresh:%s", claims.UserID))
	// Blacklist the access token (by jti) until its natural expiry so a
	// logged-out access token cannot be replayed before the 15m TTL elapses.
	s.blacklistToken(claims)

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/v1/auth/users — list all users (admin)
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	rows, err := s.db.Query(context.Background(),
		`SELECT id, username, COALESCE(email,''), COALESCE(avatar_url,''), subscription_tier, created_at, COALESCE(last_seen, created_at), COALESCE(preferences,'{}'::jsonb)
		 FROM users ORDER BY created_at DESC LIMIT 200`,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to list users")
		return
	}
	defer rows.Close()

	type UserItem struct {
		ID               string    `json:"id"`
		Username         string    `json:"username"`
		Email            string    `json:"email,omitempty"`
		AvatarURL        string    `json:"avatar_url,omitempty"`
		SubscriptionTier string    `json:"subscription_tier"`
		CreatedAt        time.Time `json:"created_at"`
		LastSeen         time.Time `json:"last_seen"`
		TotpEnabled      bool      `json:"totp_enabled"`
		TotpRequired     bool      `json:"totp_required"`
	}

	users := []UserItem{}
	for rows.Next() {
		var u UserItem
		var prefsJSON []byte
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.AvatarURL, &u.SubscriptionTier, &u.CreatedAt, &u.LastSeen, &prefsJSON); err != nil {
			continue
		}
		var prefs map[string]interface{}
		if json.Unmarshal(prefsJSON, &prefs) == nil {
			secret, _ := prefs["totp_secret"].(string)
			u.TotpEnabled = secret != ""
			req2FA, _ := prefs["totp_required"].(bool)
			u.TotpRequired = req2FA
		}
		if u.Email == "" {
			u.Email = ""
		}
		users = append(users, u)
	}
	writeJSON(w, http.StatusOK, users)
}

// DELETE /api/v1/auth/users/:id  — delete user (admin)
// PATCH  /api/v1/auth/users/:id  — promote/demote user (admin)
func (s *Server) handleManageUser(w http.ResponseWriter, r *http.Request) {
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	// Extract user ID from path: /api/v1/auth/users/:id
	targetID := strings.TrimPrefix(r.URL.Path, "/api/v1/auth/users/")
	targetID = strings.TrimSuffix(targetID, "/")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "User ID required")
		return
	}

	// TOTP admin sub-actions: /api/v1/auth/users/:id/totp/reset | /totp/require
	if idx := strings.Index(targetID, "/totp/"); idx != -1 {
		userID := targetID[:idx]
		action := strings.TrimPrefix(targetID[idx:], "/totp/")
		s.handleAdminTOTP(w, r, userID, action)
		return
	}

	switch r.Method {
	case http.MethodDelete:
		if targetID == claims.UserID {
			writeError(w, http.StatusBadRequest, "self_delete", "Cannot delete your own account")
			return
		}
		_, err := s.db.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, targetID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to delete user")
			return
		}
		s.redis.Del(context.Background(), fmt.Sprintf("refresh:%s", targetID))
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})

	case http.MethodPatch:
		var body struct {
			Role string `json:"role"` // "admin" or "free"
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || (body.Role != "admin" && body.Role != "free") {
			writeError(w, http.StatusBadRequest, "invalid_request", "role must be 'admin' or 'free'")
			return
		}
		_, err := s.db.Exec(context.Background(),
			`UPDATE users SET subscription_tier = $1 WHERE id = $2`, body.Role, targetID,
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to update user role")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "role": body.Role})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleAdminTOTP — admin management of a user's 2FA.
//
//	POST /api/v1/auth/users/:id/totp/reset   — disable 2FA (remove secret + requirement)
//	POST /api/v1/auth/users/:id/totp/require — force (re-)setup on next login
func (s *Server) handleAdminTOTP(w http.ResponseWriter, r *http.Request, userID, action string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if userID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "User ID required")
		return
	}

	switch action {
	case "reset":
		_, err := s.db.Exec(r.Context(),
			`UPDATE users SET preferences = (COALESCE(preferences,'{}'::jsonb) - 'totp_secret') - 'totp_required' WHERE id = $1`,
			userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to reset 2FA")
			return
		}
		// Invalidate any active refresh token so a reset takes effect immediately.
		s.redis.Del(r.Context(), fmt.Sprintf("refresh:%s", userID))
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "totp_reset", "totp_enabled": false, "totp_required": false})

	case "require":
		_, err := s.db.Exec(r.Context(),
			`UPDATE users SET preferences = (COALESCE(preferences,'{}'::jsonb) - 'totp_secret') || jsonb_build_object('totp_required', true) WHERE id = $1`,
			userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to require 2FA")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "totp_required", "totp_enabled": false, "totp_required": true})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// ── Permission group management (admin) ──────────────────────────────────────

// GET /api/v1/admin/groups — list all permission groups (admin)
// POST /api/v1/admin/groups — create a permission group (admin)
func (s *Server) handleGroups(w http.ResponseWriter, r *http.Request) {
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		rows, err := s.db.Query(r.Context(),
			`SELECT id, name, is_global, is_anonymous_default, permissions
			 FROM permission_groups ORDER BY name`)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to list groups")
			return
		}
		defer rows.Close()

		groups := []PermissionGroup{}
		for rows.Next() {
			var g PermissionGroup
			var permsJSON []byte
			if err := rows.Scan(&g.ID, &g.Name, &g.IsGlobal, &g.IsAnonymousDefault, &permsJSON); err != nil {
				continue
			}
			g.Permissions = parsePermissions(permsJSON)
			groups = append(groups, g)
		}
		writeJSON(w, http.StatusOK, groups)

	case http.MethodPost:
		var req struct {
			Name        string          `json:"name"`
			Permissions map[string]bool `json:"permissions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" || len(req.Name) > 64 {
			writeError(w, http.StatusBadRequest, "invalid_name", "name must be 1-64 characters")
			return
		}
		perms := normalizePermissions(req.Permissions)
		permsJSON, _ := json.Marshal(perms)

		var id string
		err := s.db.QueryRow(r.Context(),
			`INSERT INTO permission_groups (name, is_global, is_anonymous_default, permissions)
			 VALUES ($1, FALSE, FALSE, $2) RETURNING id`,
			req.Name, permsJSON,
		).Scan(&id)
		if err != nil {
			if strings.Contains(err.Error(), "unique") {
				writeError(w, http.StatusConflict, "group_exists", "A group with this name already exists")
				return
			}
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to create group")
			return
		}
		writeJSON(w, http.StatusCreated, PermissionGroup{ID: id, Name: req.Name, Permissions: perms})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// PATCH/DELETE /api/v1/admin/groups/:id and POST /api/v1/admin/groups/:id/assign-user
func (s *Server) handleGroupByID(w http.ResponseWriter, r *http.Request) {
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	trimmed := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/groups/")
	parts := strings.SplitN(trimmed, "/", 2)
	id := parts[0]
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "Group ID required")
		return
	}

	if len(parts) == 2 && parts[1] == "assign-user" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.handleAssignUserToGroup(w, r, id)
		return
	}

	switch r.Method {
	case http.MethodPatch:
		s.handleUpdateGroup(w, r, id)
	case http.MethodDelete:
		s.handleDeleteGroup(w, r, id)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// PATCH /api/v1/admin/groups/:id — update a group's name and/or permissions (admin)
func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Name        *string         `json:"name"`
		Permissions map[string]bool `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	// Load current values so we can apply a partial update.
	var name string
	var permsJSON []byte
	if err := s.db.QueryRow(r.Context(),
		`SELECT name, permissions FROM permission_groups WHERE id = $1`, id,
	).Scan(&name, &permsJSON); err != nil {
		writeError(w, http.StatusNotFound, "group_not_found", "Group not found")
		return
	}

	newName := name
	if req.Name != nil {
		newName = strings.TrimSpace(*req.Name)
		if newName == "" || len(newName) > 64 {
			writeError(w, http.StatusBadRequest, "invalid_name", "name must be 1-64 characters")
			return
		}
	}

	newPerms := parsePermissions(permsJSON)
	if req.Permissions != nil {
		newPerms = normalizePermissions(req.Permissions)
	}
	newPermsJSON, _ := json.Marshal(newPerms)

	_, err := s.db.Exec(r.Context(),
		`UPDATE permission_groups SET name = $1, permissions = $2 WHERE id = $3`,
		newName, newPermsJSON, id,
	)
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			writeError(w, http.StatusConflict, "group_exists", "A group with this name already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to update group")
		return
	}

	writeJSON(w, http.StatusOK, PermissionGroup{ID: id, Name: newName, Permissions: newPerms})
}

// DELETE /api/v1/admin/groups/:id — delete a group (global groups are protected)
func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request, id string) {
	var isGlobal bool
	err := s.db.QueryRow(r.Context(),
		`SELECT is_global FROM permission_groups WHERE id = $1`, id,
	).Scan(&isGlobal)
	if err != nil {
		writeError(w, http.StatusNotFound, "group_not_found", "Group not found")
		return
	}
	if isGlobal {
		writeError(w, http.StatusBadRequest, "global_group_protected", "Global groups cannot be deleted")
		return
	}

	// Detach any users from the group before deleting it.
	s.db.Exec(r.Context(), `UPDATE users SET permission_group_id = NULL WHERE permission_group_id = $1`, id)
	if _, err := s.db.Exec(r.Context(), `DELETE FROM permission_groups WHERE id = $1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to delete group")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// POST /api/v1/admin/groups/:id/assign-user — assign a user to a group (admin)
func (s *Server) handleAssignUserToGroup(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UserID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "user_id required")
		return
	}

	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM permission_groups WHERE id = $1)`, id,
	).Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "group_not_found", "Group not found")
		return
	}

	res, err := s.db.Exec(r.Context(),
		`UPDATE users SET permission_group_id = $1 WHERE id = $2`, id, req.UserID,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to assign user")
		return
	}
	if res.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "assigned", "user_id": req.UserID, "group_id": id})
}

// ── IP whitelist helpers (Docker API proxy) ─────────────────────────────────

// internalCIDRs are the private/loopback ranges the Docker proxy allows.
var internalCIDRs = []string{
	"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128", "fc00::/7",
}

// clientIP extracts the originating client IP. When behind Kong the real client
// IP is appended to X-Forwarded-For; otherwise fall back to the TCP peer address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isInternalIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	for _, cidr := range internalCIDRs {
		_, ipnet, err := net.ParseCIDR(cidr)
		if err == nil && ipnet.Contains(ip) {
			return true
		}
	}
	return false
}

// requireInternalOrigin rejects requests whose client IP is not localhost or a
// private/internal range. Used to harden the Docker API proxy.
func (s *Server) requireInternalOrigin(w http.ResponseWriter, r *http.Request) bool {
	if !s.config.DockerProxyInternalOnly {
		return true
	}
	if isInternalIP(clientIP(r)) {
		return true
	}
	writeError(w, http.StatusForbidden, "forbidden", "Docker API proxy is restricted to internal network")
	return false
}

// Docker container response type
type DockerContainer struct {
	ID     string   `json:"id"`
	Names  []string `json:"Names"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

// GET /api/v1/auth/admin/docker/containers
func (s *Server) handleDockerList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}
	if !s.requireInternalOrigin(w, r) {
		return
	}

	req, _ := http.NewRequest("GET", "http://localhost/containers/json?all=1", nil)
	resp, err := dockerClient.Do(req)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "docker_error", "Cannot connect to Docker socket")
		return
	}
	defer resp.Body.Close()

	var raw []struct {
		ID     string   `json:"Id"`
		Names  []string `json:"Names"`
		State  string   `json:"State"`
		Status string   `json:"Status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		writeError(w, http.StatusInternalServerError, "parse_error", "Failed to parse Docker response")
		return
	}

	type ContainerInfo struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		State  string `json:"state"`
		Status string `json:"status"`
	}
	result := make([]ContainerInfo, 0, len(raw))
	for _, c := range raw {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		result = append(result, ContainerInfo{ID: c.ID[:12], Name: name, State: c.State, Status: c.Status})
	}
	writeJSON(w, http.StatusOK, result)
}

// POST /api/v1/auth/admin/docker/containers/:name/start|stop|restart
func (s *Server) handleDockerAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}
	if !s.requireInternalOrigin(w, r) {
		return
	}

	// Path: /api/v1/auth/admin/docker/containers/:name/start|stop|restart
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/v1/auth/admin/docker/containers/")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) != 2 {
		writeError(w, http.StatusBadRequest, "bad_path", "Expected /containers/:name/start|stop|restart")
		return
	}
	containerName, action := parts[0], parts[1]
	if action != "start" && action != "stop" && action != "restart" {
		writeError(w, http.StatusBadRequest, "bad_action", "Action must be start, stop, or restart")
		return
	}

	url := fmt.Sprintf("http://localhost/containers/%s/%s", containerName, action)
	req, _ := http.NewRequest("POST", url, nil)
	resp, err := dockerClient.Do(req)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "docker_error", "Cannot connect to Docker socket")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		writeError(w, http.StatusNotFound, "not_found", "Container not found")
		return
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		writeError(w, http.StatusInternalServerError, "docker_error", string(body))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "action": action, "container": containerName})
}

// GET /api/v1/auth/admin/docker/containers/:name/logs
func (s *Server) handleDockerLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}
	if !s.requireInternalOrigin(w, r) {
		return
	}

	// Path: /api/v1/auth/admin/docker/containers/:name/logs
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/v1/auth/admin/docker/containers/")
	containerName := strings.TrimSuffix(trimmed, "/logs")

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "200"
	}

	url := fmt.Sprintf("http://localhost/containers/%s/logs?stdout=1&stderr=1&tail=%s&timestamps=1", containerName, tail)
	req, _ := http.NewRequest("GET", url, nil)
	resp, err := dockerClient.Do(req)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "docker_error", "Cannot connect to Docker socket")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		writeError(w, http.StatusNotFound, "not_found", "Container not found")
		return
	}

	// Docker multiplexes stdout/stderr with an 8-byte header per frame.
	// We strip headers and return plain text lines.
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read_error", "Failed to read logs")
		return
	}

	// Strip Docker stream framing (8-byte header: [stream_type, 0,0,0, size(4 bytes)])
	var lines []string
	for i := 0; i < len(raw); {
		if i+8 > len(raw) {
			break
		}
		frameSize := int(raw[i+4])<<24 | int(raw[i+5])<<16 | int(raw[i+6])<<8 | int(raw[i+7])
		i += 8
		if i+frameSize > len(raw) {
			frameSize = len(raw) - i
		}
		line := strings.TrimRight(string(raw[i:i+frameSize]), "\n\r")
		if line != "" {
			lines = append(lines, line)
		}
		i += frameSize
	}
	if lines == nil {
		lines = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"container": containerName, "lines": lines})
}

// GET /api/v1/auth/admin/redis/info
func (s *Server) handleRedisInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	ctx := r.Context()
	infoRaw, err := s.redis.Info(ctx, "all").Result()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "redis_error", "Cannot connect to Redis")
		return
	}

	parsed := map[string]string{}
	for _, line := range strings.Split(infoRaw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			parsed[parts[0]] = strings.TrimSpace(parts[1])
		}
	}

	dbsize, _ := s.redis.DBSize(ctx).Result()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"version":            parsed["redis_version"],
		"uptime_seconds":     parsed["uptime_in_seconds"],
		"connected_clients":  parsed["connected_clients"],
		"used_memory_human":  parsed["used_memory_human"],
		"used_memory_peak":   parsed["used_memory_peak_human"],
		"total_commands":     parsed["total_commands_processed"],
		"keyspace_hits":      parsed["keyspace_hits"],
		"keyspace_misses":    parsed["keyspace_misses"],
		"rdb_last_save_time": parsed["rdb_last_save_time"],
		"aof_enabled":        parsed["aof_enabled"],
		"role":               parsed["role"],
		"dbsize":             dbsize,
	})
}

// POST /api/v1/auth/admin/redis/flush
func (s *Server) handleRedisFlush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil || !claims.IsAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "Admin access required")
		return
	}

	var body struct {
		DB string `json:"db"` // "current" or "all"
	}
	json.NewDecoder(r.Body).Decode(&body)

	ctx := r.Context()
	if body.DB == "all" {
		if err := s.redis.FlushAll(ctx).Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "redis_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "flushed all databases"})
	} else {
		if err := s.redis.FlushDB(ctx).Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "redis_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "flushed current database"})
	}
}

// POST /api/v1/auth/change-password
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "weak_password", "New password must be at least 8 characters")
		return
	}

	var passwordHash string
	err = s.db.QueryRow(context.Background(),
		`SELECT password_hash FROM users WHERE id = $1`, claims.UserID,
	).Scan(&passwordHash)
	if err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.CurrentPassword)); err != nil {
		writeError(w, http.StatusUnauthorized, "wrong_password", "Current password is incorrect")
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), s.config.BcryptCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash_error", "Failed to hash password")
		return
	}

	_, err = s.db.Exec(context.Background(),
		`UPDATE users SET password_hash = $1 WHERE id = $2`, string(newHash), claims.UserID,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to update password")
		return
	}

	// Revoke all refresh tokens so existing sessions must re-login
	s.redis.Del(context.Background(), fmt.Sprintf("refresh:%s", claims.UserID))

	writeJSON(w, http.StatusOK, map[string]string{"status": "password_changed"})
}

// POST /api/v1/auth/verify (internal — called by ws-gateway)
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "token required")
		return
	}

	claims, err := s.validateToken(body.Token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid token")
		return
	}

	// Prefer the permissions embedded in the JWT (avoids a DB roundtrip on
	// every internal verify call); fall back to a fresh resolve for legacy
	// tokens that predate the permissions claim.
	perms := claims.Permissions
	if perms == nil {
		perms = s.resolvePermissions(r.Context(), claims.UserID)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"valid":       true,
		"user_id":     claims.UserID,
		"username":    claims.Username,
		"is_admin":    claims.IsAdmin,
		"permissions": perms,
	})
}

// ── Email verification ────────────────────────────────────────────────────

func generateToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// sendVerificationEmail generates a token, stores it in Redis, and sends the email.
// Called asynchronously — errors are logged but never bubble up to the caller.
func (s *Server) sendVerificationEmail(userID, username, email string) {
	if s.config.SMTPHost == "" {
		return
	}
	token, err := generateToken()
	if err != nil {
		log.Printf("sendVerificationEmail: generate token error: %v", err)
		return
	}
	ctx := context.Background()
	s.redis.Set(ctx, "email_verify:"+token, userID, 24*time.Hour)

	link := fmt.Sprintf("%s/api/v1/auth/verify-email?token=%s", s.config.FrontendURL, token)
	htmlBody := fmt.Sprintf(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Подтверждение email</title></head>
<body style="margin:0;padding:0;background:#09090f;font-family:sans-serif;color:#e2e8f0;">
<table width="100%%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px;">
<table width="480" cellpadding="0" cellspacing="0" style="background:#13131f;border-radius:12px;border:1px solid rgba(124,111,247,0.2);overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#1a1535,#0d0d1a);padding:28px 32px;text-align:center;">
<div style="font-size:26px;font-weight:700;color:#a78bfa;letter-spacing:-0.5px;">Watch<span style="color:#f472b6;">Sync</span></div>
<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;">Синхронный просмотр видео</div>
</td></tr>
<tr><td style="padding:32px;">
<p style="margin:0 0 8px;font-size:16px;color:#e2e8f0;">Привет, <strong style="color:#a78bfa;">%s</strong>!</p>
<p style="margin:0 0 24px;font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;">Для завершения регистрации подтвердите ваш адрес электронной почты, нажав на кнопку ниже.</p>
<div style="text-align:center;margin:28px 0;">
<a href="%s" style="display:inline-block;background:linear-gradient(135deg,#7c6ff7,#6d28d9);color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.2px;">Подтвердить email</a>
</div>
<p style="margin:24px 0 0;font-size:12px;color:rgba(255,255,255,0.35);line-height:1.5;">Ссылка действительна 24 часа. Если кнопка не работает, скопируйте эту ссылку в браузер:<br>
<span style="color:rgba(124,111,247,0.7);word-break:break-all;">%s</span></p>
<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;">
<p style="margin:0;font-size:11px;color:rgba(255,255,255,0.2);">Если вы не регистрировались на WatchSync — просто проигнорируйте это письмо.</p>
</td></tr></table></td></tr></table></body></html>`, username, link, link)

	body := fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: Подтвердите email — WatchSync\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s",
		s.config.SMTPFrom, email, htmlBody,
	)
	addr := s.config.SMTPHost + ":" + s.config.SMTPPort
	var auth smtp.Auth
	if s.config.SMTPUser != "" {
		auth = smtp.PlainAuth("", s.config.SMTPUser, s.config.SMTPPass, s.config.SMTPHost)
	}
	if err := smtp.SendMail(addr, auth, s.config.SMTPFrom, []string{email}, []byte(body)); err != nil {
		log.Printf("sendVerificationEmail: smtp error for %s: %v", email, err)
	}
}

// GET /api/v1/auth/verify-email?token=...
func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		writeError(w, http.StatusBadRequest, "missing_token", "token parameter required")
		return
	}
	ctx := context.Background()
	userID, err := s.redis.Get(ctx, "email_verify:"+token).Result()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_token", "Token is invalid or expired")
		return
	}
	_, err = s.db.Exec(ctx, `UPDATE users SET email_verified = TRUE WHERE id = $1`, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to verify email")
		return
	}
	s.redis.Del(ctx, "email_verify:"+token)

	if s.config.FrontendURL != "" {
		http.Redirect(w, r, s.config.FrontendURL+"/?email_verified=1", http.StatusFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "verified"})
}

// POST /api/v1/auth/resend-verification
func (s *Server) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.extractClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required")
		return
	}
	var email string
	var verified bool
	err = s.db.QueryRow(context.Background(),
		`SELECT COALESCE(email,''), COALESCE(email_verified,false) FROM users WHERE id = $1`, claims.UserID,
	).Scan(&email, &verified)
	if err != nil || email == "" {
		writeError(w, http.StatusBadRequest, "no_email", "No email address on this account")
		return
	}
	if verified {
		writeJSON(w, http.StatusOK, map[string]string{"status": "already_verified"})
		return
	}
	rateLimitKey := fmt.Sprintf("resend_limit:%s", claims.UserID)
	count, _ := s.redis.Incr(context.Background(), rateLimitKey).Result()
	if count == 1 {
		s.redis.Expire(context.Background(), rateLimitKey, time.Hour)
	}
	if count > 3 {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again in an hour.")
		return
	}
	go s.sendVerificationEmail(claims.UserID, claims.Username, email)
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// Token helpers
func (s *Server) generateTokens(userID, username string, isAdmin bool) (string, string, error) {
	now := time.Now()
	perms := s.resolvePermissions(context.Background(), userID)

	// jti (JWT ID) enables per-token invalidation via Redis blacklist on logout.
	accessJTI, err := generateToken()
	if err != nil {
		return "", "", err
	}

	accessClaims := &Claims{
		UserID:      userID,
		Username:    username,
		IsAdmin:     isAdmin,
		Permissions: perms,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.config.JWTAccessTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        accessJTI,
			Subject:   userID,
			Issuer:    "watchsync",
		},
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString([]byte(s.config.JWTSecret))
	if err != nil {
		return "", "", err
	}

	refreshClaims := &Claims{
		UserID:   userID,
		Username: username,
		IsAdmin:  isAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.config.JWTRefreshTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			Subject:   userID,
			Issuer:    "watchsync",
		},
	}
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString([]byte(s.config.JWTSecret))
	if err != nil {
		return "", "", err
	}

	return accessToken, refreshToken, nil
}

func (s *Server) validateToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(s.config.JWTSecret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	if s.isTokenBlacklisted(claims) {
		return nil, fmt.Errorf("token revoked")
	}
	return claims, nil
}

// isTokenBlacklisted reports whether a token's jti is in the Redis blacklist
// (set on logout; entries expire when the access token would have expired).
func (s *Server) isTokenBlacklisted(claims *Claims) bool {
	if claims == nil || claims.ID == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	exists, err := s.redis.Exists(ctx, "blacklist:jti:"+claims.ID).Result()
	if err != nil {
		return false
	}
	return exists > 0
}

// blacklistToken stores a token's jti in Redis until its natural expiry.
func (s *Server) blacklistToken(claims *Claims) {
	if claims == nil || claims.ID == "" {
		return
	}
	ctx := context.Background()
	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl <= 0 {
		ttl = s.config.JWTAccessTTL
	}
	s.redis.Set(ctx, "blacklist:jti:"+claims.ID, "1", ttl)
}

func (s *Server) extractClaims(r *http.Request) (*Claims, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, fmt.Errorf("no authorization header")
	}
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || parts[0] != "Bearer" {
		return nil, fmt.Errorf("invalid authorization header format")
	}
	return s.validateToken(parts[1])
}

func (s *Server) storeRefreshToken(userID, token string) {
	ctx := context.Background()
	key := fmt.Sprintf("refresh:%s", userID)
	s.redis.Set(ctx, key, token, s.config.JWTRefreshTTL)
}

// Response helpers
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func parseDuration(s, defaultVal string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		d, _ = time.ParseDuration(defaultVal)
	}
	return d
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
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

func getEnvBool(key string, defaultValue bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return defaultValue
}

func main() {
	config := &Config{
		Port:          getEnv("PORT", "8080"),
		DBHost:        getEnv("DB_HOST", "localhost"),
		DBPort:        getEnv("DB_PORT", "5432"),
		DBUser:        getEnv("DB_USER", "watchsync"),
		DBPassword:    getEnv("DB_PASSWORD", "changeme"),
		DBName:        getEnv("DB_NAME", "watchsync"),
		DBSSLMode:     getEnv("DB_SSL_MODE", "disable"),
		JWTSecret:     getEnv("JWT_SECRET", "change-me-in-production"),
		JWTAccessTTL:  parseDuration(getEnv("JWT_ACCESS_TTL", "15m"), "15m"),
		JWTRefreshTTL: parseDuration(getEnv("JWT_REFRESH_TTL", "168h"), "168h"),
		RedisHost:     getEnv("REDIS_HOST", "localhost"),
		RedisPort:     getEnv("REDIS_PORT", "6379"),
		RedisDB:       getEnvInt("REDIS_DB", 0),
		BcryptCost:    12,
		SMTPHost:      getEnv("SMTP_HOST", ""),
		SMTPPort:      getEnv("SMTP_PORT", "587"),
		SMTPUser:      getEnv("SMTP_USER", ""),
		SMTPPass:      getEnv("SMTP_PASS", ""),
		SMTPFrom:               getEnv("SMTP_FROM", "noreply@watchsync.local"),
		FrontendURL:            getEnv("FRONTEND_URL", ""),
		EmailVerifyTimeoutDays: getEnvInt("EMAIL_VERIFY_TIMEOUT_DAYS", 0),
		DockerProxyInternalOnly: getEnvBool("DOCKER_PROXY_INTERNAL_ONLY", true),
	}

	if config.JWTSecret == "change-me-in-production" {
		log.Println("WARNING: JWT_SECRET is using the default insecure value — set JWT_SECRET in .env")
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/auth/register", server.handleRegister)
	mux.HandleFunc("/api/v1/auth/anonymous", server.handleAnonymousLogin)
	mux.HandleFunc("/api/v1/auth/login", server.handleLogin)
	mux.HandleFunc("/api/v1/auth/me", server.handleMe)
	mux.HandleFunc("/api/v1/auth/refresh", server.handleRefresh)
	mux.HandleFunc("/api/v1/auth/logout", server.handleLogout)
	mux.HandleFunc("/api/v1/auth/change-password", server.handleChangePassword)
	mux.HandleFunc("/api/v1/auth/verify", server.handleVerify)
	mux.HandleFunc("/api/v1/auth/totp/setup", server.handleTOTPSetup)
	mux.HandleFunc("/api/v1/auth/totp/enable", server.handleTOTPEnable)
	mux.HandleFunc("/api/v1/auth/totp/disable", server.handleTOTPDisable)
	mux.HandleFunc("/api/v1/auth/totp/verify", server.handleTOTPVerify)
	mux.HandleFunc("/api/v1/auth/verify-email", server.handleVerifyEmail)
	mux.HandleFunc("/api/v1/auth/resend-verification", server.handleResendVerification)
	mux.HandleFunc("/api/v1/auth/users/", server.handleManageUser) // per-user actions (must be before /users)
	mux.HandleFunc("/api/v1/auth/users", server.handleListUsers)
	mux.HandleFunc("/api/v1/admin/groups/", server.handleGroupByID) // PATCH/DELETE/assign-user
	mux.HandleFunc("/api/v1/admin/groups", server.handleGroups)    // GET/POST
	mux.HandleFunc("/api/v1/auth/admin/docker/containers", server.handleDockerList)
	mux.HandleFunc("/api/v1/auth/admin/docker/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			server.handleDockerLogs(w, r)
		} else {
			server.handleDockerAction(w, r)
		}
	})
	mux.HandleFunc("/api/v1/auth/admin/redis/info", server.handleRedisInfo)
	mux.HandleFunc("/api/v1/auth/admin/redis/flush", server.handleRedisFlush)
	mux.HandleFunc("/api/v1/auth/admin/broadcast", server.handleAdminBroadcast)
	mux.HandleFunc("/api/v1/push/vapid-key", server.handleVAPIDKey)
	mux.HandleFunc("/api/v1/push/subscribe", server.handlePushSubscribe)
	mux.HandleFunc("/api/v1/auth/desktop/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write([]byte(`{"version":"1.0.0","download_url":"/downloads/WatchSync-1.0.0-win64.zip","release_notes":"Bug fixes and improvements"}`))
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"auth-service"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Auth service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

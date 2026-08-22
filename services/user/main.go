package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Config struct {
	Port               string
	DBHost             string
	DBPort             string
	DBUser             string
	DBPassword         string
	DBName             string
	DBSSLMode          string
	MinioEndpoint      string
	MinioAccessKey     string
	MinioSecretKey     string
	MinioBucketAvatars string
	RedisHost          string
	RedisPort          string
}

type Server struct {
	config *Config
	db     *pgxpool.Pool
	minio  *minio.Client
	redis  *redis.Client
}

type UserProfile struct {
	ID               string           `json:"id"`
	Username         string           `json:"username"`
	Email            string           `json:"email,omitempty"`
	AvatarURL        string           `json:"avatar_url,omitempty"`
	Badge            string           `json:"badge,omitempty"`
	Status           string           `json:"status,omitempty"`
	Privacy          *PrivacySettings `json:"privacy,omitempty"`
	Preferences      any              `json:"preferences,omitempty"`
	SubscriptionTier string           `json:"subscription_tier"`
	CreatedAt        time.Time        `json:"created_at"`
	LastSeen         *time.Time       `json:"last_seen,omitempty"`
}

type UpdateProfileRequest struct {
	Email    string           `json:"email,omitempty"`
	Username string           `json:"username,omitempty"`
	Theme    string           `json:"theme,omitempty"` // dark | light | amoled
	Privacy  *PrivacySettings `json:"privacy,omitempty"`
	Badge    *string          `json:"badge,omitempty"`  // pointer: nil = not provided, "" = clear
	Status   *string          `json:"status,omitempty"` // pointer: nil = not provided, "" = clear
	IsAdult  *bool            `json:"is_adult,omitempty"` // 18+ confirmation (self-declared)
}

// PrivacySettings controls which parts of the profile are visible to others.
// Pointers distinguish "not provided" (nil) from an explicit boolean value.
type PrivacySettings struct {
	ShowWatchTime    *bool `json:"show_watch_time,omitempty"`
	ShowHistory      *bool `json:"show_history,omitempty"`
	ShowAchievements *bool `json:"show_achievements,omitempty"`
}

// Achievement is a single unlockable badge.
type Achievement struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
}

// HistoryEntry mirrors the JSON record ws-gateway pushes into watch:history:{userID}.
type HistoryEntry struct {
	RoomID    string `json:"room_id"`
	Title     string `json:"title"`
	Timestamp int64  `json:"timestamp"`
	Seconds   int64  `json:"seconds"`
}

// DailyActivity is watch activity aggregated per calendar day (heatmap input).
type DailyActivity struct {
	Date    string `json:"date"`    // YYYY-MM-DD
	Weekday int    `json:"weekday"` // 0=Sunday .. 6=Saturday (time.Weekday)
	Seconds int64  `json:"seconds"`
	Count   int    `json:"count"`
}

// WeekdayTotal aggregates activity per day of week (0=Sunday .. 6=Saturday).
type WeekdayTotal struct {
	Weekday int    `json:"weekday"`
	Label   string `json:"label"`
	Seconds int64  `json:"seconds"`
}

// ContinueEntry mirrors the JSON record ws-gateway pushes into watch:continue:{userID}.
type ContinueEntry struct {
	RoomID      string  `json:"room_id"`
	VideoURL    string  `json:"video_url"`
	Title       string  `json:"title"`
	CurrentTime float64 `json:"current_time"`
	Timestamp   int64   `json:"timestamp"`
}

// achievements is the canonical set of badges and their unlock conditions.
// Unlock conditions are evaluated in evaluateAchievements().
var achievements = []Achievement{
	{ID: "first_watch", Name: "Первый просмотр", Icon: "👀", Description: "Посмотрите первое видео"},
	{ID: "centurion", Name: "Сотник", Icon: "🏆", Description: "100 часов просмотра"},
	{ID: "night_owl", Name: "Полуночник", Icon: "🦉", Description: "Смотрели после полуночи"},
	{ID: "binge", Name: "Марафон", Icon: "🎬", Description: "6+ часов подряд"},
	{ID: "social", Name: "Душа компании", Icon: "🤝", Description: "Побывали в 10 разных комнатах"},
	{ID: "host", Name: "Хозяин", Icon: "👑", Description: "Создали 5 комнат"},
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

	mc, err := minio.New(s.config.MinioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s.config.MinioAccessKey, s.config.MinioSecretKey, ""),
		Secure: false,
	})
	if err != nil {
		return fmt.Errorf("minio client creation failed: %w", err)
	}
	s.minio = mc
	log.Println("Connected to MinIO")

	s.redis = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:%s", s.config.RedisHost, s.config.RedisPort),
		DB:   1, // same DB as ws-gateway where watch:total keys are stored
	})
	if err := s.redis.Ping(context.Background()).Err(); err != nil {
		log.Printf("Redis connection warning: %v (watch stats will be unavailable)", err)
	} else {
		log.Println("Connected to Redis")
	}

	return nil
}

// GET /api/v1/users/me/history
// Returns recent entries plus a per-day (heatmap) and per-weekday aggregation.
func (s *Server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	entries, err := s.readWatchHistory(context.Background(), userID, 20)
	if err != nil || entries == nil {
		entries = []HistoryEntry{}
	}

	daily := buildDailyAggregation(entries)
	weekdayTotals := buildWeekdayTotals(daily)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"entries":        entries,
		"daily":          daily,
		"weekday_totals": weekdayTotals,
	})
}

// readWatchHistory reads the watch:history:{userID} Redis list. limit <= 0 means all.
func (s *Server) readWatchHistory(ctx context.Context, userID string, limit int64) ([]HistoryEntry, error) {
	histKey := fmt.Sprintf("watch:history:%s", userID)
	var items []string
	var err error
	if limit > 0 {
		items, err = s.redis.LRange(ctx, histKey, 0, limit-1).Result()
	} else {
		items, err = s.redis.LRange(ctx, histKey, 0, -1).Result()
	}
	if err != nil {
		return nil, err
	}
	entries := make([]HistoryEntry, 0, len(items))
	for _, item := range items {
		var e HistoryEntry
		if json.Unmarshal([]byte(item), &e) == nil {
			entries = append(entries, e)
		}
	}
	return entries, nil
}

// buildDailyAggregation groups history entries by calendar day, ascending.
func buildDailyAggregation(entries []HistoryEntry) []DailyActivity {
	byDate := map[string]*DailyActivity{}
	for _, e := range entries {
		t := time.Unix(e.Timestamp, 0)
		date := t.Format("2006-01-02")
		d, ok := byDate[date]
		if !ok {
			d = &DailyActivity{Date: date, Weekday: int(t.Weekday())}
			byDate[date] = d
		}
		d.Seconds += e.Seconds
		d.Count++
	}
	dates := make([]string, 0, len(byDate))
	for date := range byDate {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	out := make([]DailyActivity, 0, len(dates))
	for _, date := range dates {
		out = append(out, *byDate[date])
	}
	return out
}

var weekdayLabels = [...]string{"Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"}

// buildWeekdayTotals aggregates activity per day of week (0=Sunday .. 6=Saturday).
func buildWeekdayTotals(daily []DailyActivity) []WeekdayTotal {
	totals := make([]WeekdayTotal, 7)
	for i := 0; i < 7; i++ {
		totals[i] = WeekdayTotal{Weekday: i, Label: weekdayLabels[i]}
	}
	for _, d := range daily {
		totals[d.Weekday].Seconds += d.Seconds
	}
	return totals
}

// startWatchTimeFlushLoop periodically flushes Redis watch:total:* to PostgreSQL preferences
func (s *Server) startWatchTimeFlushLoop() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		s.flushWatchTimesToPostgres()
	}
}

func (s *Server) flushWatchTimesToPostgres() {
	ctx := context.Background()
	keys, err := s.redis.Keys(ctx, "watch:total:*").Result()
	if err != nil {
		return
	}
	for _, key := range keys {
		userID := strings.TrimPrefix(key, "watch:total:")
		val, err := s.redis.Get(ctx, key).Result()
		if err != nil {
			continue
		}
		watchSeconds, err := strconv.ParseInt(val, 10, 64)
		if err != nil || watchSeconds <= 0 {
			continue
		}
		s.db.Exec(ctx,
			`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{watch_seconds}', to_jsonb($1::bigint)) WHERE id = $2`,
			watchSeconds, userID,
		)

		// Evaluate achievements against accumulated watch time / history / rooms.
		s.evaluateAchievements(ctx, userID)
	}
}

// GET /api/v1/users/me/stats
func (s *Server) handleGetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	ctx := context.Background()
	totalKey := fmt.Sprintf("watch:total:%s", userID)
	val, err := s.redis.Get(ctx, totalKey).Result()
	var watchSeconds int64
	if err == nil {
		watchSeconds, _ = strconv.ParseInt(val, 10, 64)
	}

	// Per-type breakdown: watch:type:{userID}:{video_type}
	breakdown := make(map[string]int64)
	for _, vt := range []string{"youtube", "local", "hls", "embed"} {
		typeKey := fmt.Sprintf("watch:type:%s:%s", userID, vt)
		if tv, err := s.redis.Get(ctx, typeKey).Result(); err == nil {
			if n, perr := strconv.ParseInt(tv, 10, 64); perr == nil {
				breakdown[vt] = n
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"watch_seconds": watchSeconds,
		"watch_hours":   watchSeconds / 3600,
		"watch_minutes": (watchSeconds % 3600) / 60,
		"breakdown":     breakdown,
	})
}

// GET /api/v1/users/:id  (also dispatches GET /api/v1/users/:id/public)
func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Public profile sub-route: /api/v1/users/{id}/public
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/users/")
	if strings.HasSuffix(rest, "/public") {
		s.handleGetPublicProfile(w, r)
		return
	}

	// Require authentication — extract userID from JWT or X-User-ID header
	if extractUserID(r) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required")
		return
	}

	id := rest

	var user UserProfile
	var emailNull, avatarNull *string
	var prefRaw []byte
	err := s.db.QueryRow(context.Background(),
		`SELECT id, username, email, avatar_url, subscription_tier, created_at, last_seen, COALESCE(preferences,'{}'::jsonb)
		 FROM users WHERE id = $1`, id,
	).Scan(&user.ID, &user.Username, &emailNull, &avatarNull,
		&user.SubscriptionTier, &user.CreatedAt, &user.LastSeen, &prefRaw)

	if err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	if emailNull != nil {
		user.Email = *emailNull
	}
	if avatarNull != nil {
		user.AvatarURL = *avatarNull
	}

	var prefs struct {
		Badge   string          `json:"badge"`
		Status  string          `json:"status"`
		Privacy PrivacySettings `json:"privacy"`
	}
	if len(prefRaw) > 0 && json.Unmarshal(prefRaw, &prefs) == nil {
		user.Badge = prefs.Badge
		user.Status = prefs.Status
		user.Privacy = &prefs.Privacy
	}

	writeJSON(w, http.StatusOK, user)
}

// PATCH /api/v1/users/me
func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	var req UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	_, err := s.db.Exec(context.Background(),
		`UPDATE users SET
			email = COALESCE(NULLIF($2,''), email),
			username = COALESCE(NULLIF($3,''), username)
		 WHERE id = $1`,
		userID, req.Email, req.Username,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to update profile")
		return
	}

	// Persist theme preference if provided
	if req.Theme != "" {
		validThemes := map[string]bool{"dark": true, "light": true, "amoled": true}
		if validThemes[req.Theme] {
			s.db.Exec(context.Background(),
				`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{theme}', to_jsonb($1::text)) WHERE id = $2`,
				req.Theme, userID,
			)
		}
	}

	// Badge (display badge, ≤ 20 chars). Empty string clears it.
	if req.Badge != nil {
		badge := truncateRunes(strings.TrimSpace(*req.Badge), 20)
		if badge == "" {
			s.db.Exec(context.Background(),
				`UPDATE users SET preferences = COALESCE(preferences,'{}'::jsonb) - 'badge' WHERE id = $1`, userID)
		} else {
			s.db.Exec(context.Background(),
				`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{badge}', to_jsonb($2::text)) WHERE id = $1`,
				userID, badge)
		}
	}

	// Status (short text, ≤ 50 chars). Empty string clears it.
	if req.Status != nil {
		status := truncateRunes(strings.TrimSpace(*req.Status), 50)
		if status == "" {
			s.db.Exec(context.Background(),
				`UPDATE users SET preferences = COALESCE(preferences,'{}'::jsonb) - 'status' WHERE id = $1`, userID)
		} else {
			s.db.Exec(context.Background(),
				`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{status}', to_jsonb($2::text)) WHERE id = $1`,
				userID, status)
		}
	}

	// 18+ confirmation (self-declared) — required to join 18+ rooms.
	if req.IsAdult != nil {
		s.db.Exec(context.Background(),
			`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{is_adult}', to_jsonb($1::bool)) WHERE id = $2`,
			*req.IsAdult, userID)
	}

	// Privacy settings — merge provided booleans into preferences.privacy JSONB.
	if req.Privacy != nil {
		var privBytes []byte
		if err := s.db.QueryRow(context.Background(),
			`SELECT COALESCE(preferences->'privacy','{}'::jsonb) FROM users WHERE id = $1`, userID).Scan(&privBytes); err == nil {
			priv := map[string]interface{}{}
			if len(privBytes) > 0 {
				json.Unmarshal(privBytes, &priv)
			}
			if req.Privacy.ShowWatchTime != nil {
				priv["show_watch_time"] = *req.Privacy.ShowWatchTime
			}
			if req.Privacy.ShowHistory != nil {
				priv["show_history"] = *req.Privacy.ShowHistory
			}
			if req.Privacy.ShowAchievements != nil {
				priv["show_achievements"] = *req.Privacy.ShowAchievements
			}
			if privJSON, err := json.Marshal(priv); err == nil {
				s.db.Exec(context.Background(),
					`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{privacy}', $2::jsonb) WHERE id = $1`,
					userID, string(privJSON))
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// truncateRunes truncates a UTF-8 string to max runes without splitting characters.
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

// POST /api/v1/users/me/avatar
func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	r.ParseMultipartForm(10 << 20) // 10MB limit
	file, header, err := r.FormFile("avatar")
	if err != nil {
		writeError(w, http.StatusBadRequest, "no_file", "No avatar file provided")
		return
	}
	defer file.Close()

	objectName := fmt.Sprintf("avatars/%s/%d_%s", userID, time.Now().Unix(), header.Filename)
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}

	_, err = s.minio.PutObject(context.Background(),
		s.config.MinioBucketAvatars,
		objectName,
		file,
		header.Size,
		minio.PutObjectOptions{ContentType: contentType},
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "upload_error", "Failed to upload avatar")
		return
	}

	avatarURL := fmt.Sprintf("http://%s/%s/%s", s.config.MinioEndpoint, s.config.MinioBucketAvatars, objectName)

	_, err = s.db.Exec(context.Background(),
		`UPDATE users SET avatar_url = $2 WHERE id = $1`,
		userID, avatarURL,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to update avatar URL")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"avatar_url": avatarURL})
}

// Stream-proxies a MinIO object (for avatar serving)
func (s *Server) handleGetAvatar(w http.ResponseWriter, r *http.Request) {
	objectName := strings.TrimPrefix(r.URL.Path, "/api/v1/users/avatar/")
	obj, err := s.minio.GetObject(context.Background(), s.config.MinioBucketAvatars, objectName, minio.GetObjectOptions{})
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	defer obj.Close()
	w.Header().Set("Content-Type", "image/jpeg")
	io.Copy(w, obj)
}

// ─── Achievements ─────────────────────────────────────────────────────────────

const achievementChannel = "achievement_unlocked" // Redis pub/sub → ws-gateway forwards to the user's WS

// readWatchTotal reads watch:total:{userID} from Redis, 0 on any error.
func (s *Server) readWatchTotal(ctx context.Context, userID string) int64 {
	val, err := s.redis.Get(ctx, fmt.Sprintf("watch:total:%s", userID)).Result()
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseInt(val, 10, 64)
	return n
}

// countDistinctRooms counts rooms the user has ever joined (room_members).
func (s *Server) countDistinctRooms(ctx context.Context, userID string) int {
	var count int
	if err := s.db.QueryRow(ctx,
		`SELECT COUNT(DISTINCT room_id) FROM room_members WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return 0
	}
	return count
}

// countOwnedRooms counts rooms the user created (rooms.owner_id).
func (s *Server) countOwnedRooms(ctx context.Context, userID string) int {
	var count int
	if err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM rooms WHERE owner_id = $1`, userID).Scan(&count); err != nil {
		return 0
	}
	return count
}

// evaluateAchievements checks every achievement condition and unlocks any that
// are satisfied but not yet recorded. Idempotent: unlock uses ON CONFLICT DO NOTHING.
func (s *Server) evaluateAchievements(ctx context.Context, userID string) {
	total := s.readWatchTotal(ctx, userID)
	history, _ := s.readWatchHistory(ctx, userID, 0)
	distinctRooms := s.countDistinctRooms(ctx, userID)
	ownedRooms := s.countOwnedRooms(ctx, userID)

	for _, ach := range achievements {
		if !achievementConditionMet(ach.ID, total, history, distinctRooms, ownedRooms) {
			continue
		}
		newlyUnlocked, err := s.unlockAchievement(ctx, userID, ach)
		if err != nil {
			log.Printf("achievement unlock failed for %s (%s): %v", userID, ach.ID, err)
			continue
		}
		if newlyUnlocked {
			s.publishAchievement(ctx, userID, ach)
		}
	}
}

func achievementConditionMet(id string, total int64, history []HistoryEntry, distinctRooms, ownedRooms int) bool {
	switch id {
	case "first_watch":
		return total > 0 || len(history) > 0
	case "centurion":
		return total >= 360000 // 100 hours
	case "night_owl":
		for _, e := range history {
			h := time.Unix(e.Timestamp, 0).Hour()
			if h >= 0 && h < 6 { // 00:00–05:59 local time
				return true
			}
		}
		return false
	case "binge":
		for _, e := range history {
			if e.Seconds >= 21600 { // 6 hours in a single session
				return true
			}
		}
		return false
	case "social":
		return distinctRooms >= 10
	case "host":
		return ownedRooms >= 5
	}
	return false
}

func (s *Server) unlockAchievement(ctx context.Context, userID string, ach Achievement) (bool, error) {
	tag, err := s.db.Exec(ctx,
		`INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id, achievement_id) DO NOTHING`,
		userID, ach.ID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Server) publishAchievement(ctx context.Context, userID string, ach Achievement) {
	payload, err := json.Marshal(map[string]interface{}{
		"user_id": userID,
		"id":      ach.ID,
		"name":    ach.Name,
		"icon":    ach.Icon,
	})
	if err != nil {
		return
	}
	if err := s.redis.Publish(ctx, achievementChannel, payload).Err(); err != nil {
		log.Printf("achievement publish failed: %v", err)
	}
}

func (s *Server) readUnlockedAchievements(ctx context.Context, userID string) ([]map[string]interface{}, error) {
	unlocked := map[string]time.Time{}
	rows, err := s.db.Query(ctx,
		`SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var at time.Time
		if rows.Scan(&id, &at) == nil {
			unlocked[id] = at
		}
	}
	out := []map[string]interface{}{}
	for _, ach := range achievements {
		if at, ok := unlocked[ach.ID]; ok {
			out = append(out, map[string]interface{}{
				"id": ach.ID, "name": ach.Name, "icon": ach.Icon, "unlocked_at": at,
			})
		}
	}
	return out, nil
}

// GET /api/v1/users/me/achievements
func (s *Server) handleGetAchievements(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	ctx := context.Background()
	// Evaluate on-demand so a freshly satisfied condition unlocks immediately.
	s.evaluateAchievements(ctx, userID)

	unlocked := map[string]time.Time{}
	rows, err := s.db.Query(ctx,
		`SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = $1`, userID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			var at time.Time
			if rows.Scan(&id, &at) == nil {
				unlocked[id] = at
			}
		}
	}

	list := make([]map[string]interface{}, 0, len(achievements))
	unlockedCount := 0
	for _, ach := range achievements {
		at, ok := unlocked[ach.ID]
		item := map[string]interface{}{
			"id":          ach.ID,
			"name":        ach.Name,
			"icon":        ach.Icon,
			"description": ach.Description,
			"unlocked":    ok,
		}
		if ok {
			item["unlocked_at"] = at
			unlockedCount++
		}
		list = append(list, item)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"achievements":   list,
		"unlocked_count": unlockedCount,
		"total":          len(achievements),
	})
}

// ─── Favorites ───────────────────────────────────────────────────────────────

func (s *Server) getFavorites(ctx context.Context, userID string) ([]string, error) {
	var raw []byte
	if err := s.db.QueryRow(ctx,
		`SELECT COALESCE(preferences->'favorites','[]'::jsonb) FROM users WHERE id = $1`, userID).Scan(&raw); err != nil {
		return nil, err
	}
	var favs []string
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &favs); err != nil {
			return nil, err
		}
	}
	if favs == nil {
		favs = []string{}
	}
	return favs, nil
}

func (s *Server) setFavorites(ctx context.Context, userID string, favs []string) error {
	b, err := json.Marshal(favs)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx,
		`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{favorites}', $2::jsonb) WHERE id = $1`,
		userID, string(b))
	return err
}

func (s *Server) getRoomName(ctx context.Context, roomID string) string {
	var name string
	if err := s.db.QueryRow(ctx, `SELECT name FROM rooms WHERE id = $1`, roomID).Scan(&name); err != nil {
		return ""
	}
	return name
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// GET /api/v1/users/me/favorites
func (s *Server) handleGetFavorites(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}
	ctx := context.Background()
	favs, err := s.getFavorites(ctx, userID)
	if err != nil {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}
	out := make([]map[string]string, 0, len(favs))
	for _, rid := range favs {
		out = append(out, map[string]string{"room_id": rid, "name": s.getRoomName(ctx, rid)})
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/v1/users/me/favorites/{roomId}
func (s *Server) handleAddFavorite(w http.ResponseWriter, r *http.Request) {
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}
	roomID := r.PathValue("roomId")
	if roomID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "roomId required")
		return
	}
	ctx := context.Background()
	favs, err := s.getFavorites(ctx, userID)
	if err != nil {
		favs = []string{}
	}
	if !containsString(favs, roomID) {
		favs = append(favs, roomID)
		s.setFavorites(ctx, userID, favs)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "room_id": roomID})
}

// DELETE /api/v1/users/me/favorites/{roomId}
func (s *Server) handleDeleteFavorite(w http.ResponseWriter, r *http.Request) {
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}
	roomID := r.PathValue("roomId")
	ctx := context.Background()
	favs, err := s.getFavorites(ctx, userID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok"})
		return
	}
	nf := make([]string, 0, len(favs))
	for _, rid := range favs {
		if rid != roomID {
			nf = append(nf, rid)
		}
	}
	s.setFavorites(ctx, userID, nf)
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok"})
}

// ─── Continue watching ───────────────────────────────────────────────────────

// GET /api/v1/users/me/continue
func (s *Server) handleGetContinue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	userID := extractUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "auth required")
		return
	}

	ctx := context.Background()
	key := fmt.Sprintf("watch:continue:%s", userID)
	items, err := s.redis.LRange(ctx, key, 0, 4).Result()
	entries := []ContinueEntry{}
	if err == nil {
		for _, item := range items {
			var e ContinueEntry
			if json.Unmarshal([]byte(item), &e) == nil {
				entries = append(entries, e)
			}
		}
	}
	writeJSON(w, http.StatusOK, entries)
}

// ─── Public profile ──────────────────────────────────────────────────────────

// GET /api/v1/users/{id}/public
func (s *Server) handleGetPublicProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if extractUserID(r) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/users/")
	id := strings.TrimSuffix(rest, "/public")
	if id == "" || id == rest {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	ctx := context.Background()
	var (
		username, tier string
		createdAt      time.Time
		prefRaw        []byte
		avatarNull     *string
	)
	err := s.db.QueryRow(ctx,
		`SELECT username, avatar_url, subscription_tier, created_at, COALESCE(preferences,'{}'::jsonb) FROM users WHERE id = $1`, id,
	).Scan(&username, &avatarNull, &tier, &createdAt, &prefRaw)
	if err != nil {
		writeError(w, http.StatusNotFound, "user_not_found", "User not found")
		return
	}

	var avatar string
	if avatarNull != nil {
		avatar = *avatarNull
	}

	var prefs struct {
		Badge   string          `json:"badge"`
		Status  string          `json:"status"`
		Privacy PrivacySettings `json:"privacy"`
	}
	json.Unmarshal(prefRaw, &prefs)

	out := map[string]interface{}{
		"id":                id,
		"username":          username,
		"avatar_url":        avatar,
		"badge":             prefs.Badge,
		"status":            prefs.Status,
		"subscription_tier": tier,
		"created_at":        createdAt,
	}

	if prefs.Privacy.ShowWatchTime != nil && *prefs.Privacy.ShowWatchTime {
		out["watch_seconds"] = s.readWatchTotal(ctx, id)
	}
	if prefs.Privacy.ShowAchievements != nil && *prefs.Privacy.ShowAchievements {
		ach, _ := s.readUnlockedAchievements(ctx, id)
		out["achievements"] = ach
	}

	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

// extractUserID extracts the user ID from X-User-ID header or JWT Bearer token.
// Kong validates the JWT signature; user-service trusts the validated payload.
func extractUserID(r *http.Request) string {
	if uid := r.Header.Get("X-User-ID"); uid != "" {
		return uid
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		token := strings.TrimPrefix(auth, "Bearer ")
		parts := strings.Split(token, ".")
		if len(parts) == 3 {
			payload, err := base64.RawURLEncoding.DecodeString(parts[1])
			if err == nil {
				var claims struct {
					Sub    string `json:"sub"`
					UserID string `json:"user_id"`
				}
				if json.Unmarshal(payload, &claims) == nil {
					if claims.UserID != "" {
						return claims.UserID
					}
					return claims.Sub
				}
			}
		}
	}
	return ""
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

func main() {
	config := &Config{
		Port:               getEnv("PORT", "8080"),
		DBHost:             getEnv("DB_HOST", "localhost"),
		DBPort:             getEnv("DB_PORT", "5432"),
		DBUser:             getEnv("DB_USER", "watchsync"),
		DBPassword:         getEnv("DB_PASSWORD", "changeme"),
		DBName:             getEnv("DB_NAME", "watchsync"),
		DBSSLMode:          getEnv("DB_SSL_MODE", "disable"),
		MinioEndpoint:      getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:     getEnv("MINIO_ACCESS_KEY", "minioadmin"),
		MinioSecretKey:     getEnv("MINIO_SECRET_KEY", "minioadmin"),
		MinioBucketAvatars: getEnv("MINIO_BUCKET_AVATARS", "avatars"),
		RedisHost:          getEnv("REDIS_HOST", "localhost"),
		RedisPort:          getEnv("REDIS_PORT", "6379"),
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	go server.startWatchTimeFlushLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/users/me/history", server.handleGetHistory)
	mux.HandleFunc("/api/v1/users/me/stats", server.handleGetStats)
	mux.HandleFunc("/api/v1/users/me/achievements", server.handleGetAchievements)
	mux.HandleFunc("/api/v1/users/me/favorites", server.handleGetFavorites)
	mux.HandleFunc("POST /api/v1/users/me/favorites/{roomId}", server.handleAddFavorite)
	mux.HandleFunc("DELETE /api/v1/users/me/favorites/{roomId}", server.handleDeleteFavorite)
	mux.HandleFunc("/api/v1/users/me/continue", server.handleGetContinue)
	mux.HandleFunc("/api/v1/users/me/avatar", server.handleUploadAvatar)
	mux.HandleFunc("/api/v1/users/me", server.handleUpdateProfile)
	mux.HandleFunc("/api/v1/users/avatar/", server.handleGetAvatar)
	mux.HandleFunc("/api/v1/users/", server.handleGetUser)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"user-service"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("User service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

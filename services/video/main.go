package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/net/proxy"
)

var uuidRegexp = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ── Proxy upstream Prometheus metrics ─────────────────────────────────────────
var (
	proxyUpstreamRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "proxy_upstream_requests_total",
		Help: "Total proxy requests routed through each upstream",
	}, []string{"upstream_id", "upstream_name"})

	proxyUpstreamErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "proxy_upstream_errors_total",
		Help: "Total proxy errors per upstream",
	}, []string{"upstream_id", "upstream_name"})

	proxyUpstreamDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "proxy_upstream_duration_seconds",
		Help:    "Proxy request duration per upstream",
		Buckets: prometheus.DefBuckets,
	}, []string{"upstream_id", "upstream_name"})

	proxyUpstreamBytes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "proxy_upstream_bytes_total",
		Help: "Total bytes transferred per upstream",
	}, []string{"upstream_id", "upstream_name"})
)

// upstreamHealth stores per-upstream health check results (in-memory, refreshed every 60s)
var upstreamHealthMap sync.Map // id → *UpstreamHealthStatus

type UpstreamHealthStatus struct {
	OK        bool      `json:"ok"`
	LatencyMs int64     `json:"latency_ms"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
}

type Config struct {
	Port              string
	DBHost            string
	DBPort            string
	DBUser            string
	DBPassword        string
	DBName            string
	DBSSLMode         string
	MinioEndpoint     string
	MinioAccessKey    string
	MinioSecretKey    string
	MinioVideoBucket  string
	YoutubeAPIKey     string
	MaxQueueSize      int
	NatsURL           string
	RedisHost         string
	RedisPort         string
}

// ── Video chunk cache ─────────────────────────────────────────────────────────
// Caches 4 MB aligned chunks from MinIO files so range requests from multiple
// clients are served from memory after the first fetch.
// Hot-warms head (first 40 MB) + tail (last 40 MB) on first access — this
// covers the MP4 moov atom (usually at end) and the opening video frames.

const (
	vcChunkSize   = 4 * 1024 * 1024  // 4 MB aligned chunk
	vcHeadBytes   = 40 * 1024 * 1024 // pre-warm first 40 MB
	vcTailBytes   = 40 * 1024 * 1024 // pre-warm last 40 MB
	vcMaxTotalMB  = 800              // evict when cache exceeds 800 MB
)

// chunkKey returns the aligned chunk start for a byte offset.
func chunkKey(offset int64) int64 { return (offset / vcChunkSize) * vcChunkSize }

type vcFileMeta struct {
	total       int64
	modTime     time.Time
	contentType string
}

type videoFileCache struct {
	mu     sync.Mutex
	chunks map[string][]byte   // "objectName:chunkOffset" → data (≤ vcChunkSize)
	meta   map[string]*vcFileMeta
	total  int64               // bytes in cache
	loads  map[string]bool     // prevent duplicate goroutines per chunk
}

func newVideoFileCache() *videoFileCache {
	return &videoFileCache{
		chunks: make(map[string][]byte),
		meta:   make(map[string]*vcFileMeta),
		loads:  make(map[string]bool),
	}
}

func vcKey(objectName string, offset int64) string {
	return objectName + ":" + strconv.FormatInt(offset, 10)
}

// getChunk returns a cached chunk or nil.
func (c *videoFileCache) getChunk(objectName string, offset int64) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.chunks[vcKey(objectName, offset)]
}

// putChunk stores a chunk and evicts LRU if over budget.
func (c *videoFileCache) putChunk(objectName string, offset int64, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := vcKey(objectName, offset)
	if _, ok := c.chunks[k]; ok {
		return // already cached
	}
	// Evict arbitrary chunks when over budget (simple random eviction)
	for c.total+int64(len(data)) > int64(vcMaxTotalMB)*1024*1024 {
		for key, chunk := range c.chunks {
			delete(c.chunks, key)
			c.total -= int64(len(chunk))
			break
		}
	}
	c.chunks[k] = data
	c.total += int64(len(data))
}

func (c *videoFileCache) getMeta(objectName string) *vcFileMeta {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.meta[objectName]
}

func (c *videoFileCache) putMeta(objectName string, m *vcFileMeta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.meta[objectName] = m
}

// fetchAndCacheChunk fetches exactly one aligned chunk from MinIO and caches it.
// Uses a dedup lock so concurrent callers for the same chunk only trigger one fetch.
func (c *videoFileCache) fetchAndCacheChunk(objectName string, chunkOff int64, mc *minio.Client, bucket string, totalSize int64) {
	loadKey := vcKey(objectName, chunkOff)
	c.mu.Lock()
	if c.loads[loadKey] || c.chunks[loadKey] != nil {
		c.mu.Unlock()
		return
	}
	c.loads[loadKey] = true
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.loads, loadKey)
			c.mu.Unlock()
		}()

		end := chunkOff + vcChunkSize - 1
		if totalSize > 0 && end >= totalSize {
			end = totalSize - 1
		}
		opts := minio.GetObjectOptions{}
		opts.SetRange(chunkOff, end)

		obj, err := mc.GetObject(context.Background(), bucket, objectName, opts)
		if err != nil {
			return
		}
		defer obj.Close()

		data, err := io.ReadAll(obj)
		if err != nil || len(data) == 0 {
			return
		}
		c.putChunk(objectName, chunkOff, data)
	}()
}

// warmFile asynchronously pre-fetches head + tail chunks for fast startup.
// Must be called with the file's total size already known.
func (c *videoFileCache) warmFile(objectName string, mc *minio.Client, bucket string, total int64) {
	// Head: first vcHeadBytes
	for off := int64(0); off < vcHeadBytes && off < total; off += vcChunkSize {
		c.fetchAndCacheChunk(objectName, off, mc, bucket, total)
	}
	// Tail: last vcTailBytes (moov atom lives here for non-faststart MP4)
	tailStart := total - vcTailBytes
	if tailStart < vcHeadBytes {
		tailStart = vcHeadBytes // avoid double-caching
	}
	for off := chunkKey(tailStart); off < total; off += vcChunkSize {
		c.fetchAndCacheChunk(objectName, off, mc, bucket, total)
	}
}

// ensureMeta fetches and caches file metadata (size, modTime, CT) if not already known.
func (c *videoFileCache) ensureMeta(objectName string, mc *minio.Client, bucket string) (*vcFileMeta, error) {
	if m := c.getMeta(objectName); m != nil {
		return m, nil
	}
	obj, err := mc.GetObject(context.Background(), bucket, objectName, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	info, err := obj.Stat()
	obj.Close()
	if err != nil {
		return nil, err
	}
	ct := info.ContentType
	if ct == "" {
		ct = "video/mp4"
	}
	m := &vcFileMeta{total: info.Size, modTime: info.LastModified, contentType: ct}
	c.putMeta(objectName, m)
	return m, nil
}

// chunkProgress returns how many of the head+tail chunks are cached (0-100).
func (c *videoFileCache) chunkProgress(objectName string, total int64) (loaded, target int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	countChunks := func(from, to int64) (int64, int64) {
		var cached, tot int64
		for off := chunkKey(from); off < to; off += vcChunkSize {
			tot++
			if c.chunks[vcKey(objectName, off)] != nil {
				cached++
			}
		}
		return cached, tot
	}
	headEnd := int64(vcHeadBytes)
	if headEnd > total { headEnd = total }
	c1, t1 := countChunks(0, headEnd)

	tailStart := total - int64(vcTailBytes)
	if tailStart < headEnd { tailStart = headEnd }
	c2, t2 := countChunks(tailStart, total)

	return c1 + c2, t1 + t2
}

type Server struct {
	config     *Config
	db         *pgxpool.Pool
	minio      *minio.Client
	nats       *nats.Conn
	redis      *redis.Client
	videoCache *videoFileCache
}

type QueueItem struct {
	ID            string    `json:"id"`
	RoomID        string    `json:"room_id"`
	AddedBy       string    `json:"added_by,omitempty"`
	VideoSource   string    `json:"video_source"`
	VideoURL      string    `json:"video_url"`
	Title         string    `json:"title,omitempty"`
	ThumbnailURL  string    `json:"thumbnail_url,omitempty"`
	VideoMetadata any       `json:"video_metadata,omitempty"`
	Position      int       `json:"position"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
}

type AddToQueueRequest struct {
	UserID        string            `json:"user_id"`
	VideoSource   string            `json:"video_source"` // local, youtube, hls, direct, embed
	VideoURL      string            `json:"video_url"`
	Title         string            `json:"title,omitempty"`
	ThumbnailURL  string            `json:"thumbnail_url,omitempty"`
	StreamHeaders map[string]string `json:"stream_headers,omitempty"` // extra headers for proxy (e.g. Referer for Kodik CDN)
}

func NewServer(cfg *Config) *Server {
	return &Server{config: cfg, videoCache: newVideoFileCache()}
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

	rdb := redis.NewClient(&redis.Options{
		Addr: s.config.RedisHost + ":" + s.config.RedisPort,
		DB:   2, // DB 2: proxy chunk cache
	})
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Printf("Redis connection failed (chunk cache disabled): %v", err)
	} else {
		s.redis = rdb
		log.Println("Connected to Redis (chunk cache DB 2)")
	}

	s.loadCacheJobsFromRedis()

	if s.config.NatsURL != "" {
		nc, natsErr := nats.Connect(s.config.NatsURL,
			nats.RetryOnFailedConnect(true),
			nats.MaxReconnects(5),
			nats.ReconnectWait(2*time.Second),
		)
		if natsErr != nil {
			log.Printf("NATS connection failed (queue broadcast disabled): %v", natsErr)
		} else {
			s.nats = nc
			log.Println("Connected to NATS")
		}
	}

	return nil
}

const proxyChunkMaxBytes = 512 * 1024 // cache only responses ≤ 512 KB (HLS segments)
const proxyChunkTTL = 10 * time.Minute

func proxyChunkKey(rawURL, rangeHeader string) string {
	h := sha256.Sum256([]byte(rawURL + "|" + rangeHeader))
	return "proxy_chunk:" + hex.EncodeToString(h[:16])
}

func (s *Server) broadcastQueueUpdate(roomID string) {
	if s.nats == nil {
		return
	}
	rows, err := s.db.Query(context.Background(),
		`SELECT id, room_id, COALESCE(added_by::text,''), video_source, video_url,
		        video_metadata, position, status, created_at
		 FROM video_queue WHERE room_id = $1 AND status != 'completed'
		 ORDER BY position ASC`,
		roomID,
	)
	if err != nil {
		return
	}
	defer rows.Close()
	items := []QueueItem{}
	for rows.Next() {
		var item QueueItem
		var metaJSON []byte
		if scanErr := rows.Scan(&item.ID, &item.RoomID, &item.AddedBy, &item.VideoSource,
			&item.VideoURL, &metaJSON, &item.Position, &item.Status, &item.CreatedAt); scanErr != nil {
			continue
		}
		if metaJSON != nil {
			var meta map[string]string
			if json.Unmarshal(metaJSON, &meta) == nil {
				item.Title = meta["title"]
				item.ThumbnailURL = meta["thumbnail_url"]
			}
		}
		items = append(items, item)
	}
	payload := map[string]any{"items": items}
	if len(items) > 0 {
		payload["current"] = items[0]
	}
	msg := map[string]any{
		"type":    "queue_update",
		"payload": payload,
	}
	data, _ := json.Marshal(msg)
	s.nats.Publish(fmt.Sprintf("room.%s.broadcast", roomID), data)
}

// GET /api/v1/rooms/:id/queue
func (s *Server) handleGetQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomID := extractRoomID(r.URL.Path)

	rows, err := s.db.Query(context.Background(),
		`SELECT id, room_id, COALESCE(added_by::text,''), video_source, video_url,
		        video_metadata, position, status, created_at
		 FROM video_queue
		 WHERE room_id = $1
		 AND status != 'completed'
		 ORDER BY position ASC`,
		roomID,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to fetch queue")
		return
	}
	defer rows.Close()

	items := []QueueItem{}
	for rows.Next() {
		var item QueueItem
		var metaJSON []byte
		if err := rows.Scan(&item.ID, &item.RoomID, &item.AddedBy, &item.VideoSource,
			&item.VideoURL, &metaJSON, &item.Position, &item.Status, &item.CreatedAt); err != nil {
			continue
		}
		if metaJSON != nil {
			json.Unmarshal(metaJSON, &item.VideoMetadata)
			if m, ok := item.VideoMetadata.(map[string]interface{}); ok {
				if t, ok := m["title"].(string); ok {
					item.Title = t
				}
				if th, ok := m["thumbnail_url"].(string); ok {
					item.ThumbnailURL = th
				}
			}
		}
		items = append(items, item)
	}

	writeJSON(w, http.StatusOK, items)
}

// POST /api/v1/rooms/:id/queue
func (s *Server) handleAddToQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomID := extractRoomID(r.URL.Path)

	var req AddToQueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	if req.VideoURL == "" || req.VideoSource == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "video_url and video_source are required")
		return
	}

	// Get next position
	var maxPos int
	s.db.QueryRow(context.Background(),
		`SELECT COALESCE(MAX(position), 0) FROM video_queue WHERE room_id = $1`, roomID,
	).Scan(&maxPos)

	// Auto-fetch YouTube title via oEmbed (no API key required)
	title := req.Title
	thumbnail := req.ThumbnailURL
	if req.VideoSource == "youtube" {
		if title == "" {
			title = fetchYouTubeTitle(req.VideoURL)
		}
		if thumbnail == "" {
			if m := ytIDRe.FindStringSubmatch(req.VideoURL); len(m) > 1 {
				thumbnail = "https://img.youtube.com/vi/" + m[1] + "/mqdefault.jpg"
			}
		}
	}
	if title == "" {
		title = req.VideoURL
	}
	metadata := map[string]any{"title": title}
	if thumbnail != "" {
		metadata["thumbnail_url"] = thumbnail
	}
	if len(req.StreamHeaders) > 0 {
		metadata["stream_headers"] = req.StreamHeaders
	}
	metaJSON, _ := json.Marshal(metadata)

	// Reject non-UUID user IDs (e.g. guest strings like "guest_abc123")
	addedBy := req.UserID
	if !uuidRegexp.MatchString(addedBy) {
		addedBy = "" // NULLIF('','')::uuid → NULL
	}

	var item QueueItem
	err := s.db.QueryRow(context.Background(),
		`INSERT INTO video_queue (room_id, added_by, video_source, video_url, video_metadata, position)
		 VALUES ($1, NULLIF($2,'')::uuid, $3, $4, $5, $6)
		 RETURNING id, room_id, video_source, video_url, position, status, created_at`,
		roomID, addedBy, req.VideoSource, req.VideoURL, metaJSON, maxPos+1,
	).Scan(&item.ID, &item.RoomID, &item.VideoSource, &item.VideoURL,
		&item.Position, &item.Status, &item.CreatedAt)

	if err != nil {
		log.Printf("Add to queue error: %v", err)
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to add to queue")
		return
	}

	item.Title = title
	item.ThumbnailURL = thumbnail
	writeJSON(w, http.StatusCreated, item)
	go s.broadcastQueueUpdate(roomID)
}

// PATCH /api/v1/rooms/:id/queue/reorder
// Body: [{"id":"uuid","position":1}, ...]
func (s *Server) handleReorderQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var items []struct {
		ID       string `json:"id"`
		Position int    `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil || len(items) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "Expected [{id, position}]")
		return
	}

	tx, err := s.db.Begin(context.Background())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Transaction failed")
		return
	}
	defer tx.Rollback(context.Background())

	for _, item := range items {
		if _, err := tx.Exec(context.Background(),
			`UPDATE video_queue SET position = $1 WHERE id = $2`, item.Position, item.ID,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to update position")
			return
		}
	}
	if err := tx.Commit(context.Background()); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Commit failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "reordered"})
	roomID := extractRoomID(r.URL.Path)
	go s.broadcastQueueUpdate(roomID)
}

// DELETE /api/v1/rooms/:id/queue/:itemId
func (s *Server) handleRemoveFromQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/rooms/"), "/")
	if len(parts) < 3 {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path")
		return
	}
	roomID := parts[0]
	itemID := parts[2]

	_, err := s.db.Exec(context.Background(),
		`DELETE FROM video_queue WHERE id = $1`, itemID,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", "Failed to remove item")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
	go s.broadcastQueueUpdate(roomID)
}

// POST /api/v1/videos/upload — upload video to MinIO
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.ParseMultipartForm(32 << 10) // minimal in-memory; large files stream to disk
	// Accept both "file" (new standard) and legacy "video" field name
	file, header, err := r.FormFile("file")
	if err != nil {
		file, header, err = r.FormFile("video")
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "no_file", "No video file provided")
		return
	}
	defer file.Close()

	roomID := r.FormValue("room_id")

	objectName := fmt.Sprintf("videos/%d_%s", time.Now().Unix(), header.Filename)
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "video/mp4"
	}

	_, err = s.minio.PutObject(context.Background(),
		s.config.MinioVideoBucket,
		objectName,
		file,
		header.Size,
		minio.PutObjectOptions{ContentType: contentType},
	)
	if err != nil {
		log.Printf("Upload error: %v", err)
		writeError(w, http.StatusInternalServerError, "upload_error", "Failed to upload video")
		return
	}

	// Use stream proxy URL — accessible from any client via nginx/Kong
	videoURL := fmt.Sprintf("/api/v1/videos/stream/%s", objectName)

	// video_id strips the "videos/" prefix — transcoder uses it for the HLS output path
	videoID := strings.TrimPrefix(objectName, "videos/")

	// Kick off HLS adaptive transcoding asynchronously
	if s.nats != nil {
		inputURL := fmt.Sprintf("http://%s/%s/%s", s.config.MinioEndpoint, s.config.MinioVideoBucket, objectName)
		payload, _ := json.Marshal(map[string]string{
			"video_id":  videoID,
			"input_url": inputURL,
			"room_id":   roomID,
		})
		if err := s.nats.Publish("transcode.request", payload); err != nil {
			log.Printf("NATS transcode.request publish failed: %v", err)
		}
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"url":          videoURL,
		"video_id":     videoID,
		"filename":     header.Filename,
		"size":         header.Size,
		"content_type": contentType,
	})
}

// POST /api/v1/files/upload — upload chat attachment (image/document, ≤50MB) to MinIO
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.ParseMultipartForm(32 << 10) // minimal in-memory; large files stream to disk
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "no_file", "No file provided")
		return
	}
	defer file.Close()

	// Sanitize filename — strip directory traversal
	name := header.Filename
	if idx := strings.LastIndexAny(name, "/\\"); idx >= 0 {
		name = name[idx+1:]
	}

	objectName := fmt.Sprintf("chat-files/%d_%s", time.Now().Unix(), name)
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	_, err = s.minio.PutObject(context.Background(),
		s.config.MinioVideoBucket,
		objectName,
		file,
		header.Size,
		minio.PutObjectOptions{ContentType: contentType},
	)
	if err != nil {
		log.Printf("File upload error: %v", err)
		writeError(w, http.StatusInternalServerError, "upload_error", "Failed to upload file")
		return
	}

	fileURL := fmt.Sprintf("http://%s/%s/%s", s.config.MinioEndpoint, s.config.MinioVideoBucket, objectName)

	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"url":          fileURL,
		"filename":     name,
		"size":         header.Size,
		"content_type": contentType,
	})
}

// GET /api/v1/videos — list videos in MinIO
func (s *Server) handleListVideos(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	prefix := r.URL.Query().Get("prefix")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
		limit = n
	}

	objects := s.minio.ListObjects(context.Background(),
		s.config.MinioVideoBucket,
		minio.ListObjectsOptions{Prefix: prefix, Recursive: true},
	)

	videos := []map[string]interface{}{}
	count := 0
	for obj := range objects {
		if obj.Err != nil || count >= limit {
			break
		}
		videos = append(videos, map[string]interface{}{
			"name":          obj.Key,
			"size":          obj.Size,
			"last_modified": obj.LastModified,
			"url":           fmt.Sprintf("http://%s/%s/%s", s.config.MinioEndpoint, s.config.MinioVideoBucket, obj.Key),
		})
		count++
	}

	writeJSON(w, http.StatusOK, videos)
}

// readRange returns bytes [start,end] if every required chunk is cached, else nil.
func (c *videoFileCache) readRange(objectName string, start, end int64) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	for off := chunkKey(start); off <= end; off += vcChunkSize {
		if c.chunks[vcKey(objectName, off)] == nil {
			return nil
		}
	}
	result := make([]byte, end-start+1)
	var written int64
	for off := chunkKey(start); off <= end; off += vcChunkSize {
		chunk := c.chunks[vcKey(objectName, off)]
		fromInChunk := start + written - off
		if fromInChunk < 0 {
			fromInChunk = 0
		}
		toInChunk := end - off + 1
		if toInChunk > int64(len(chunk)) {
			toInChunk = int64(len(chunk))
		}
		n := copy(result[written:], chunk[fromInChunk:toInChunk])
		written += int64(n)
	}
	return result
}

// fetchRangeToCache schedules background fetch of every chunk covering [start,end].
func (c *videoFileCache) fetchRangeToCache(objectName string, start, end int64, mc *minio.Client, bucket string, total int64) {
	for off := chunkKey(start); off <= end; off += vcChunkSize {
		c.fetchAndCacheChunk(objectName, off, mc, bucket, total)
	}
}

// GET /api/v1/videos/stream/:path — stream video from MinIO with chunk cache.
//
// Hot-warms head (first 40 MB) + tail (last 40 MB) on first access.
// Subsequent range requests that fall within cached chunks are served
// entirely from memory with a manually written 206 response — zero MinIO RTT.
// ── Stream ownership check ──────────────────────────────────────────────────

// streamAuthServiceURL returns the auth-service base URL for token verification.
func streamAuthServiceURL() string {
	if v := os.Getenv("AUTH_SERVICE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://auth-service:8080"
}

// verifyStreamIdentity validates an access token against the auth-service and
// returns the authenticated user ID and admin flag. Returns an empty user ID
// when the token is missing or invalid.
func verifyStreamIdentity(token string) (userID string, isAdmin bool) {
	if token == "" {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	body, _ := json.Marshal(map[string]string{"token": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		streamAuthServiceURL()+"/api/v1/auth/verify", bytes.NewReader(body))
	if err != nil {
		return "", false
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}

	var result struct {
		Valid   bool   `json:"valid"`
		UserID  string `json:"user_id"`
		IsAdmin bool   `json:"is_admin"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || !result.Valid {
		return "", false
	}
	return result.UserID, result.IsAdmin
}

// bearerToken extracts the raw JWT from the Authorization header, falling back
// to a ?token= query parameter — HTML5 <video>/<audio> elements cannot send
// Authorization headers, so the frontend appends the token to stream URLs.
func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
		return auth[7:]
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}

// userOwnsVideo reports whether the given user may stream this file: they must
// be a member of a room whose queue contains the video (SyncWatch rooms are
// watched together, so any room member — not just the uploader — may stream it).
func (s *Server) userOwnsVideo(ctx context.Context, objectName, userID string) bool {
	if userID == "" {
		return false
	}
	videoURL := "/api/v1/videos/stream/" + objectName
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM video_queue vq
			JOIN room_members rm ON rm.room_id = vq.room_id AND rm.user_id = $2
			WHERE vq.video_url = $1
		)`, videoURL, userID).Scan(&exists)
	return err == nil && exists
}

func (s *Server) handleStreamVideo(w http.ResponseWriter, r *http.Request) {
	objectName := strings.TrimPrefix(r.URL.Path, "/api/v1/videos/stream/")

	// Ownership check: only the uploader (or an admin) may stream a
	// user-uploaded video file. Without this, any authenticated user could
	// stream someone else's file by guessing its object key.
	if strings.HasPrefix(objectName, "videos/") {
		userID, isAdmin := verifyStreamIdentity(bearerToken(r))
		if !isAdmin && (userID == "" || !s.userOwnsVideo(r.Context(), objectName, userID)) {
			writeError(w, http.StatusForbidden, "forbidden", "You can only stream your own files")
			return
		}
	}

	meta, err := s.videoCache.ensureMeta(objectName, s.minio, s.config.MinioVideoBucket)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	go s.videoCache.warmFile(objectName, s.minio, s.config.MinioVideoBucket, meta.total)

	ct := meta.contentType
	if ct == "" {
		ct = "video/mp4"
	}

	// Parse Range header.
	rangeStart, rangeEnd := int64(0), meta.total-1
	rangeRequested := false
	if rh := r.Header.Get("Range"); rh != "" {
		var rs, re int64 = 0, -1
		n, _ := fmt.Sscanf(rh, "bytes=%d-%d", &rs, &re)
		if n >= 1 {
			rangeStart = rs
			if re >= 0 && re < meta.total {
				rangeEnd = re
			}
			rangeRequested = true
		}
	}

	// Cap open-ended or oversized range requests to maxServeBytes so the browser
	// fetches the file in ~1-minute increments instead of downloading it all at once.
	// moov atom (tail) is pre-warmed, so seeking still works instantly.
	const maxServeBytes = 8 * 1024 * 1024 // ~1 min at typical 1 Mbps
	if rangeEnd-rangeStart+1 > maxServeBytes {
		rangeEnd = rangeStart + maxServeBytes - 1
		rangeRequested = true // force 206 response
	}

	// Try to serve entirely from cache.
	if data := s.videoCache.readRange(objectName, rangeStart, rangeEnd); data != nil {
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
		w.Header().Set("X-Video-Cache", "HIT")
		if rangeRequested {
			w.Header().Set("Content-Range",
				fmt.Sprintf("bytes %d-%d/%d", rangeStart, rangeEnd, meta.total))
			w.WriteHeader(http.StatusPartialContent)
		} else {
			w.Header().Set("Last-Modified", meta.modTime.UTC().Format(http.TimeFormat))
		}
		w.Write(data) //nolint:errcheck
		return
	}

	// Schedule background caching of the requested range.
	go s.videoCache.fetchRangeToCache(objectName, rangeStart, rangeEnd,
		s.minio, s.config.MinioVideoBucket, meta.total)

	// Fall back to direct MinIO streaming.
	opts := minio.GetObjectOptions{}
	if rangeRequested {
		opts.SetRange(rangeStart, rangeEnd)
	}
	obj, err := s.minio.GetObject(context.Background(),
		s.config.MinioVideoBucket, objectName, opts)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	defer obj.Close()

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("X-Video-Cache", "MISS")
	if rangeRequested {
		length := rangeEnd - rangeStart + 1
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.Header().Set("Content-Range",
			fmt.Sprintf("bytes %d-%d/%d", rangeStart, rangeEnd, meta.total))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.total, 10))
		w.Header().Set("Last-Modified", meta.modTime.UTC().Format(http.TimeFormat))
	}
	io.Copy(w, obj) //nolint:errcheck
}

// GET /api/v1/videos/prebuffer/:key — SSE stream of head+tail cache progress.
// Events: {"loaded":N,"target":N,"pct":N,"total":N,"done":bool}
func (s *Server) handlePrebuffer(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/api/v1/videos/prebuffer/")
	if key == "" {
		http.Error(w, "key required", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Ensure metadata + kick warm.
	meta, err := s.videoCache.ensureMeta(key, s.minio, s.config.MinioVideoBucket)
	if err != nil {
		fmt.Fprintf(w, "data: {\"error\":%q}\n\n", err.Error())
		flusher.Flush()
		return
	}
	go s.videoCache.warmFile(key, s.minio, s.config.MinioVideoBucket, meta.total)

	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			loaded, target := s.videoCache.chunkProgress(key, meta.total)
			pct := 0
			if target > 0 {
				pct = int(loaded * 100 / target)
			}
			done := loaded >= target && target > 0

			fmt.Fprintf(w, "data: {\"loaded\":%d,\"target\":%d,\"pct\":%d,\"total\":%d,\"done\":%v}\n\n",
				loaded*vcChunkSize, target*vcChunkSize, pct, meta.total, done)
			flusher.Flush()

			if done {
				return
			}
		}
	}
}

// GET /api/v1/rooms/{roomId}/proxy-url?url={original_url}
// Streams remote video through the server with Range request forwarding (HTTP 206).
// Bypasses client-side CORS restrictions and geo-blocks.
func (s *Server) handleProxyURL(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		writeError(w, http.StatusBadRequest, "missing_url", "url parameter required")
		return
	}
	// Guard against self-proxy recursion: reject URLs that point back to this proxy endpoint
	if strings.Contains(targetURL, "/api/v1/rooms/") && strings.Contains(targetURL, "/proxy-url") {
		writeError(w, http.StatusBadRequest, "self_proxy", "Cannot proxy a proxy URL — recursive call detected")
		return
	}
	if strings.HasPrefix(targetURL, "blob:") {
		writeError(w, http.StatusBadRequest, "blob_url", "Blob URLs cannot be proxied server-side")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_url", "Invalid URL: "+err.Error())
		return
	}

	rangeHeader := r.Header.Get("Range")
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	// Forward Referer as the origin of the target URL (helps CDNs that check referrer)
	if parsed, err2 := url.Parse(targetURL); err2 == nil {
		req.Header.Set("Referer", parsed.Scheme+"://"+parsed.Host+"/")
	}
	// Optional extra headers from caller (e.g. stream_headers from queue item: Referer for Kodik CDN)
	if headersParam := r.URL.Query().Get("headers"); headersParam != "" {
		var extraHeaders map[string]string
		if json.Unmarshal([]byte(headersParam), &extraHeaders) == nil {
			for k, v := range extraHeaders {
				req.Header.Set(k, v)
			}
		}
	}

	// Serve from chunk cache if available (only for ranged requests — HLS segments)
	if s.redis != nil && rangeHeader != "" {
		cacheKey := proxyChunkKey(targetURL, rangeHeader)
		if cached, cacheErr := s.redis.Get(r.Context(), cacheKey).Bytes(); cacheErr == nil {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges")
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Type", "video/mp2t") // assume TS segment; will be overwritten by actual type on miss
			w.Header().Set("X-Cache", "HIT")
			w.WriteHeader(http.StatusPartialContent)
			w.Write(cached)
			return
		}
	}

	upstream, proxyClient := s.selectUpstream(r.Context(), targetURL)
	proxyUpstreamRequests.WithLabelValues(upstream.ID, upstream.Name).Inc()

	start := time.Now()
	resp, err := proxyClient.Do(req)
	elapsed := time.Since(start).Seconds()
	proxyUpstreamDuration.WithLabelValues(upstream.ID, upstream.Name).Observe(elapsed)
	if err != nil {
		proxyUpstreamErrors.WithLabelValues(upstream.ID, upstream.Name).Inc()
		log.Printf("proxy-url error (%s) via %s: %v", targetURL, upstream.Name, err)
		writeError(w, http.StatusBadGateway, "fetch_error", "Cannot reach video source: "+err.Error())
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges")
	w.Header().Set("Accept-Ranges", "bytes")

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}

	// Rewrite HLS m3u8 playlists so segment URLs go through this proxy.
	// This is essential: without rewriting, the browser fetches segments directly (bypassing proxy).
	ct := resp.Header.Get("Content-Type")
	isM3U8 := strings.Contains(ct, "mpegurl") || strings.Contains(ct, "x-mpegurl") ||
		strings.HasSuffix(strings.ToLower(strings.Split(targetURL, "?")[0]), ".m3u8")
	if isM3U8 {
		rawBody, readErr := io.ReadAll(resp.Body)
		if readErr == nil {
			proxyBase := "/api/v1/rooms/" + extractRoomID(r.URL.Path) + "/proxy-url"
			rewritten := rewriteM3U8(string(rawBody), targetURL, proxyBase)
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			w.Header().Del("Content-Length") // rewritten body has different length
			w.WriteHeader(resp.StatusCode)
			w.Write([]byte(rewritten))
		} else {
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
		}
		return
	}

	// Buffer small ranged responses to cache and serve; stream large ones directly
	contentLength, _ := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	shouldCache := s.redis != nil && rangeHeader != "" && contentLength > 0 && contentLength <= proxyChunkMaxBytes

	w.WriteHeader(resp.StatusCode)

	var written int64
	if shouldCache {
		body, readErr := io.ReadAll(resp.Body)
		if readErr == nil {
			cacheKey := proxyChunkKey(targetURL, rangeHeader)
			s.redis.Set(r.Context(), cacheKey, body, proxyChunkTTL)
			n, _ := w.Write(body)
			written = int64(n)
		} else {
			written, _ = io.Copy(w, resp.Body)
		}
	} else {
		written, _ = io.Copy(w, resp.Body)
	}
	if written > 0 {
		proxyUpstreamBytes.WithLabelValues(upstream.ID, upstream.Name).Add(float64(written))
	}
}

// rewriteM3U8 rewrites segment/playlist URLs in an M3U8 body to go through the proxy.
// baseURL is the URL of the m3u8 itself; proxyBase is "/api/v1/rooms/{roomId}/proxy-url".
func rewriteM3U8(body, rawBaseURL, proxyBase string) string {
	base, err := url.Parse(rawBaseURL)
	if err != nil {
		return body
	}
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// Resolve relative or absolute segment URL against the m3u8 base
		ref, err := url.Parse(trimmed)
		if err != nil {
			continue
		}
		resolved := base.ResolveReference(ref).String()
		lines[i] = proxyBase + "?url=" + url.QueryEscape(resolved)
	}
	return strings.Join(lines, "\n")
}

// POST /api/v1/rooms/{roomId}/proxy-config
// Stateless: given a video URL, returns the proxied endpoint for that URL.
// Client sends the returned proxy_url via video_select WS event to switch all viewers.
func (s *Server) handleProxyConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")

	roomID := extractRoomID(r.URL.Path)
	if roomID == "" {
		writeError(w, http.StatusBadRequest, "missing_room", "room ID required")
		return
	}

	var req struct {
		URL           string            `json:"url"`
		Enabled       bool              `json:"enabled"`
		StreamHeaders map[string]string `json:"stream_headers,omitempty"` // extra upstream headers (e.g. Referer for Kodik)
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "url is required")
		return
	}

	if !req.Enabled {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"proxy_mode_enabled": false,
			"proxy_url":          req.URL,
			"room_id":            roomID,
		})
		return
	}

	proxyURL := "/api/v1/rooms/" + roomID + "/proxy-url?url=" + url.QueryEscape(req.URL)
	if len(req.StreamHeaders) > 0 {
		headersJSON, _ := json.Marshal(req.StreamHeaders)
		proxyURL += "&headers=" + url.QueryEscape(string(headersJSON))
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"proxy_mode_enabled": true,
		"proxy_url":          proxyURL,
		"original_url":       req.URL,
		"room_id":            roomID,
	})
}

// fetchYouTubeTitle fetches a YouTube video title using the oEmbed API (no API key required)
func fetchYouTubeTitle(videoURL string) string {
	oembedURL := "https://www.youtube.com/oembed?url=" + videoURL + "&format=json"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(oembedURL)
	if err != nil || resp.StatusCode != http.StatusOK {
		return ""
	}
	defer resp.Body.Close()
	var data struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return ""
	}
	return data.Title
}

func extractRoomID(path string) string {
	// /api/v1/rooms/:id/queue
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/rooms/"), "/")
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

// ── Embed extractor ──────────────────────────────────────────────────────────
// Known video-host patterns in order of priority
var embedHostPatterns = []*regexp.Regexp{
	// Full https:// URLs
	regexp.MustCompile(`https?://(?:kodik\.biz|kodik\.info)/[^"'\s<>]+`),
	regexp.MustCompile(`https?://alloha\.tv/[^"'\s<>]+`),
	regexp.MustCompile(`https?://ashdi\.vip/[^"'\s<>]+`),
	regexp.MustCompile(`https?://moonwalk\.\w+/[^"'\s<>]+`),
	regexp.MustCompile(`https?://sibnet\.ru/video/player/[^"'\s<>]+`),
	regexp.MustCompile(`https?://hdrezka\.ag/[^"'\s<>]+`),
	regexp.MustCompile(`https?://[^"'\s<>]+\.m3u8[^"'\s<>]*`),
	// Broad mainstream hosts (w2g/Iframely-class support)
	regexp.MustCompile(`https?://vk\.com/video_ext\.php[^"'\s<>]+`),
	regexp.MustCompile(`https?://ok\.ru/videoembed/[^"'\s<>]+`),
	regexp.MustCompile(`https?://rutube\.ru/(?:play|video)/embed/[^"'\s<>]+`),
	regexp.MustCompile(`https?://(?:player\.)?vimeo\.com/video/[^"'\s<>]+`),
	regexp.MustCompile(`https?://[^"'\s<>]*dailymotion\.com/[^"'\s<>]+`),
	regexp.MustCompile(`https?://vidoza\.net/embed-[^"'\s<>]+`),
	regexp.MustCompile(`https?://coub\.com/embed/[^"'\s<>]+`),
	// Protocol-relative URLs (//kodik.biz/...) — common on anime sites
	regexp.MustCompile(`//(?:kodik\.biz|kodik\.info)/[^"'\s<>]+`),
	regexp.MustCompile(`//alloha\.tv/[^"'\s<>]+`),
	regexp.MustCompile(`//ashdi\.vip/[^"'\s<>]+`),
	regexp.MustCompile(`//moonwalk\.\w+/[^"'\s<>]+`),
}

var iframeSrcRe = regexp.MustCompile(`(?i)<iframe[^>]+\bsrc=["']([^"']+)["']`)

// oEmbed discovery: <link rel="alternate" type="application/json+oembed" href="...">
// (attribute order varies, so match both orderings)
var oEmbedLinkRe = regexp.MustCompile(`(?i)<link[^>]+type=["']application/json\+oembed["'][^>]+href=["']([^"']+)["']`)
var oEmbedLinkRe2 = regexp.MustCompile(`(?i)<link[^>]+href=["']([^"']+)["'][^>]+type=["']application/json\+oembed["']`)

// og:video meta tags — many sites expose the direct video / embed URL here
var ogVideoIframeRe = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:video:iframe["'][^>]+content=["']([^"']+)["']`)
var ogVideoRe = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:video(?::(?:secure_)?url)?["'][^>]+content=["']([^"']+)["']`)
// data-player / data-src with known embed host — animego.me and similar
var dataPlayerRe = regexp.MustCompile(`(?i)data-(?:player|src|iframe|video)=["']([^"']*(?:kodik|alloha|ashdi|sibnet|moonwalk)[^"']*)["']`)
// JSON field "player":"//kodik..." — in inline scripts
var jsonPlayerRe = regexp.MustCompile(`(?i)["'](?:player|iframe|embed|src)["']\s*:\s*["']((?:https?:)?//(?:kodik|alloha|ashdi|sibnet|moonwalk)[^"']+)["']`)
var ogTitleRe = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']`)
var ogImageRe = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']`)
var ytIDRe = regexp.MustCompile(`(?:v=|youtu\.be/)([^&?\s]{11})`)
var h1Re = regexp.MustCompile(`(?i)<h1[^>]*>([^<]+)</h1>`)
var titleTagRe = regexp.MustCompile(`(?i)<title[^>]*>([^<]+)</title>`)

func extractPageTitle(html string) string {
	if m := ogTitleRe.FindStringSubmatch(html); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	if m := h1Re.FindStringSubmatch(html); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	if m := titleTagRe.FindStringSubmatch(html); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func extractEmbedURL(html string) string {
	normalize := func(u string) string {
		if strings.HasPrefix(u, "//") {
			return "https:" + u
		}
		return u
	}

	// Pass 0: og:video / og:video:iframe meta tags (direct embed URL exposed by many sites)
	if m := ogVideoIframeRe.FindStringSubmatch(html); len(m) > 1 {
		return normalize(htmlUnescapeAttr(m[1]))
	}
	if m := ogVideoRe.FindStringSubmatch(html); len(m) > 1 {
		return normalize(htmlUnescapeAttr(m[1]))
	}

	// Pass 1: data-player / data-src attributes (animego.me stores URL here)
	if m := dataPlayerRe.FindStringSubmatch(html); len(m) > 1 {
		return normalize(m[1])
	}

	// Pass 2: JSON "player":"//kodik..." fields inside <script> blocks
	if m := jsonPlayerRe.FindStringSubmatch(html); len(m) > 1 {
		return normalize(m[1])
	}

	// Pass 3: iframe src attributes
	for _, m := range iframeSrcRe.FindAllStringSubmatch(html, 20) {
		src := normalize(m[1])
		for _, p := range embedHostPatterns {
			if p.MatchString(src) {
				return src
			}
		}
	}

	// Pass 4: any matching URL anywhere in page source (catches inline JS vars)
	for _, p := range embedHostPatterns {
		if found := p.FindString(html); found != "" {
			return normalize(found)
		}
	}
	return ""
}

// htmlUnescapeAttr reverses the common HTML entities in a URL attribute (&amp; → &, &#38; → &).
func htmlUnescapeAttr(s string) string {
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&#38;", "&")
	return s
}

// resolveURL resolves a possibly-relative URL against a base page URL.
func resolveURL(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	u, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return base.ResolveReference(u).String()
}

// hostIsDead reports whether a hostname no longer resolves (NXDOMAIN) — a domain
// that is dead for everyone, not merely geo-blocked from this server. Only NXDOMAIN
// is treated as dead; transient or geo DNS failures are left alone so hosts that are
// reachable from the user's browser aren't false-flagged.
func hostIsDead(hostname string) bool {
	hostname = strings.TrimSuffix(strings.TrimSpace(hostname), ".")
	if hostname == "" {
		return false
	}
	_, err := net.LookupHost(hostname)
	if err == nil {
		return false
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr) && dnsErr.IsNotFound
}

// markHostDead adds host_dead + host fields to result when the embed host is NXDOMAIN.
func markHostDead(result map[string]string, embedURL string) {
	u, err := url.Parse(embedURL)
	if err != nil {
		return
	}
	if hostIsDead(u.Hostname()) {
		result["host_dead"] = "true"
		result["host"] = u.Hostname()
	}
}

func embedSource(url string) string {
	switch {
	case strings.Contains(url, "kodik."):
		return "kodik"
	case strings.Contains(url, "alloha."):
		return "alloha"
	case strings.Contains(url, "ashdi."):
		return "ashdi"
	case strings.Contains(url, "sibnet."):
		return "sibnet"
	case strings.Contains(url, ".m3u8"):
		return "hls"
	default:
		return "embed"
	}
}

// discoverOEmbedURL finds the oEmbed endpoint from the page's <link rel="alternate"> tags.
func discoverOEmbedURL(html string) string {
	var href string
	if m := oEmbedLinkRe.FindStringSubmatch(html); len(m) > 1 {
		href = m[1]
	} else if m := oEmbedLinkRe2.FindStringSubmatch(html); len(m) > 1 {
		href = m[1]
	}
	if href == "" {
		return ""
	}
	href = htmlUnescapeAttr(href)
	if strings.HasPrefix(href, "//") {
		href = "https:" + href
	}
	return href
}

// fetchOEmbed calls an oEmbed endpoint and returns its embed HTML (iframe) or direct URL.
func fetchOEmbed(ctx context.Context, oembedURL string) (string, error) {
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, oembedURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<19))
	if err != nil {
		return "", err
	}
	var data struct {
		HTML string `json:"html"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return "", err
	}
	if data.HTML != "" {
		return data.HTML, nil
	}
	if data.URL != "" {
		return data.URL, nil
	}
	return "", fmt.Errorf("oEmbed returned no html/url")
}

// iframeSrcFromHTML extracts the first iframe src from embed HTML.
func iframeSrcFromHTML(html string) string {
	if m := iframeSrcRe.FindStringSubmatch(html); len(m) > 1 {
		return htmlUnescapeAttr(m[1])
	}
	return ""
}

// POST /api/v1/embed/extract
// Body: {"url":"https://animego.me/..."}
// Returns: {"embed_url":"https://kodik.biz/...","title":"...","source":"kodik"}
func (s *Server) handleExtractEmbed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")

	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "url is required")
		return
	}
	pageURL, err := url.Parse(req.URL)
	if err != nil || pageURL.Scheme == "" || pageURL.Host == "" {
		writeError(w, http.StatusBadRequest, "invalid_url", "Invalid URL")
		return
	}

	var html string

	// Try FlareSolverr first — bypasses Cloudflare JS-challenge
	if solverrURL := os.Getenv("FLARESOLVERR_URL"); solverrURL != "" {
		if fetched, err := fetchWithFlareSolverr(r.Context(), solverrURL, req.URL); err == nil && fetched != "" {
			html = fetched
		}
	}

	// Fallback: direct HTTP (works for sites without Cloudflare protection)
	if html == "" {
		directClient := &http.Client{
			Timeout:   10 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec
		}
		httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, req.URL, nil)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_url", "Invalid URL: "+err.Error())
			return
		}
		httpReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36")
		httpReq.Header.Set("Accept-Language", "ru-RU,ru;q=0.9")
		resp, err := directClient.Do(httpReq)
		if err != nil {
			writeError(w, http.StatusBadGateway, "fetch_error", "Cannot fetch page: "+err.Error())
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<19)) // 512 KB
		if err != nil {
			writeError(w, http.StatusBadGateway, "read_error", "Cannot read page body")
			return
		}
		html = string(body)
	}

	// oEmbed discovery — the standard protocol used by Dailymotion, Vimeo, TikTok,
	// SoundCloud and 1900+ other sites. Try it before the regex-based extraction.
	if oembedURL := discoverOEmbedURL(html); oembedURL != "" {
		if oembedOut, err := fetchOEmbed(r.Context(), oembedURL); err == nil && oembedOut != "" {
			embedSrc := ""
			if strings.HasPrefix(strings.TrimSpace(oembedOut), "<") {
				// oEmbed "html" field → extract the <iframe> src.
				embedSrc = iframeSrcFromHTML(oembedOut)
			} else {
				// oEmbed "url" field → direct media/embed URL.
				embedSrc = oembedOut
			}
			if embedSrc != "" {
				source := embedSource(embedSrc)
				result := map[string]string{
					"embed_url": embedSrc,
					"title":     extractPageTitle(html),
					"source":    source,
				}
				if m := ogImageRe.FindStringSubmatch(html); len(m) > 1 {
					result["thumbnail_url"] = resolveURL(pageURL, m[1])
				}
				markHostDead(result, embedSrc)
				writeJSON(w, http.StatusOK, result)
				return
			}
			// No playable iframe/URL from oEmbed → fall through to regex extraction.
		}
	}

	embedURL := extractEmbedURL(html)
	if embedURL == "" {
		writeError(w, http.StatusNotFound, "no_embed", "No supported video player found on this page")
		return
	}

	source := embedSource(embedURL)
	// If we found an HLS stream, return it as hls type instead of embed
	if source == "hls" {
		result := map[string]string{
			"embed_url": embedURL,
			"title":     extractPageTitle(html),
			"source":    "hls",
		}
		markHostDead(result, embedURL)
		writeJSON(w, http.StatusOK, result)
		return
	}

	result := map[string]string{
		"embed_url": embedURL,
		"title":     extractPageTitle(html),
		"source":    source,
	}
	if m := ogImageRe.FindStringSubmatch(html); len(m) > 1 {
		result["thumbnail_url"] = resolveURL(pageURL, m[1])
	}
	markHostDead(result, embedURL)
	writeJSON(w, http.StatusOK, result)
}

// fetchWithFlareSolverr fetches targetURL via FlareSolverr headless Chrome,
// which automatically solves Cloudflare JS-challenges.
func fetchWithFlareSolverr(ctx context.Context, solverrURL, targetURL string) (string, error) {
	payload, _ := json.Marshal(map[string]interface{}{
		"cmd":        "request.get",
		"url":        targetURL,
		"maxTimeout": 60000,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, solverrURL+"/v1",
		bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 70 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Status   string `json:"status"`
		Message  string `json:"message"`
		Solution struct {
			Response string `json:"response"`
		} `json:"solution"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.Status != "ok" {
		return "", fmt.Errorf("flaresolverr: %s", result.Message)
	}
	return result.Solution.Response, nil
}

// ─────────────────────────────────────────────────────────────────────────────

// ── File Manager helpers ─────────────────────────────────────────────────────

// Browser-native playback without transcoding (mp4/webm/ogg/hls)
var browserSupportedExts = map[string]bool{
	"mp4": true, "webm": true, "ogg": true, "m3u8": true,
}

// Broader set of recognised media extensions for filtering in listings
var mediaExtensions = map[string]bool{
	"mp4": true, "webm": true, "ogg": true, "avi": true, "mov": true,
	"wmv": true, "flv": true, "mkv": true, "mpg": true, "mpeg": true,
	"3gp": true, "3g2": true, "ts": true, "mts": true, "m2ts": true,
	"vob": true, "f4v": true, "rm": true, "rmvb": true, "m3u8": true,
	"mp3": true, "wav": true, "aac": true, "flac": true, "m4a": true, "asf": true,
}

// isValidMinIOKey rejects keys that attempt path traversal via ".." sequences.
func isValidMinIOKey(key string) bool {
	if strings.Contains(key, "..") {
		return false
	}
	// Reject absolute paths or keys starting with /
	if strings.HasPrefix(key, "/") {
		return false
	}
	return true
}

// isSelfMove returns true when destination is inside source prefix (would create infinite loop).
func isSelfMove(src, dst string) bool {
	srcPrefix := src
	if !strings.HasSuffix(srcPrefix, "/") {
		srcPrefix += "/"
	}
	return strings.HasPrefix(dst, srcPrefix)
}

// ── File Manager handlers ────────────────────────────────────────────────────

// GET /api/v1/files?prefix=videos/
// Lists files and virtual folders at the given prefix (one level deep).
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	prefix := r.URL.Query().Get("prefix")
	if prefix != "" && !isValidMinIOKey(prefix) {
		writeError(w, http.StatusBadRequest, "invalid_prefix", "invalid prefix")
		return
	}

	type FileEntry struct {
		Key          string    `json:"key"`
		Name         string    `json:"name"`
		Size         int64     `json:"size"`
		LastModified time.Time `json:"last_modified"`
		IsDir        bool      `json:"is_dir"`
		IsSupported  bool      `json:"is_supported"`
		URL          string    `json:"url,omitempty"`
	}

	entries := []FileEntry{}
	for obj := range s.minio.ListObjects(context.Background(),
		s.config.MinioVideoBucket,
		minio.ListObjectsOptions{Prefix: prefix, Recursive: false},
	) {
		if obj.Err != nil {
			continue
		}
		if obj.Key == prefix {
			continue
		}
		isDir := strings.HasSuffix(obj.Key, "/")
		name := strings.TrimPrefix(obj.Key, prefix)
		name = strings.TrimSuffix(name, "/")
		if name == "" {
			continue
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
		entry := FileEntry{
			Key:          obj.Key,
			Name:         name,
			Size:         obj.Size,
			LastModified: obj.LastModified,
			IsDir:        isDir,
			IsSupported:  isDir || browserSupportedExts[ext],
		}
		if !isDir {
			entry.URL = fmt.Sprintf("/api/v1/videos/stream/%s", obj.Key)
		}
		entries = append(entries, entry)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"prefix": prefix, "entries": entries})
}

// DELETE /api/v1/files?key=videos/file.mp4
func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("key")
	if key == "" {
		writeError(w, http.StatusBadRequest, "missing_key", "key is required")
		return
	}
	if !isValidMinIOKey(key) {
		writeError(w, http.StatusBadRequest, "invalid_key", "invalid key")
		return
	}
	if err := s.minio.RemoveObject(context.Background(), s.config.MinioVideoBucket, key, minio.RemoveObjectOptions{}); err != nil {
		writeError(w, http.StatusInternalServerError, "delete_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// POST /api/v1/files/folder  — create virtual folder
// Body: {"path":"videos/myfolder/"}
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "path is required")
		return
	}
	if !strings.HasSuffix(body.Path, "/") {
		body.Path += "/"
	}
	_, err := s.minio.PutObject(context.Background(),
		s.config.MinioVideoBucket, body.Path,
		bytes.NewReader([]byte{}), 0,
		minio.PutObjectOptions{ContentType: "application/x-directory"},
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": body.Path})
}

// DELETE /api/v1/files/folder?prefix=videos/myfolder/
// Deletes all objects under the prefix recursively.
func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	prefix := r.URL.Query().Get("prefix")
	if prefix == "" {
		writeError(w, http.StatusBadRequest, "missing_prefix", "prefix is required")
		return
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	deleted := 0
	for obj := range s.minio.ListObjects(context.Background(),
		s.config.MinioVideoBucket,
		minio.ListObjectsOptions{Prefix: prefix, Recursive: true},
	) {
		if obj.Err != nil {
			continue
		}
		s.minio.RemoveObject(context.Background(), s.config.MinioVideoBucket, obj.Key, minio.RemoveObjectOptions{}) //nolint:errcheck
		deleted++
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"deleted": deleted})
}

// POST /api/v1/files/move
// Body: {"source":"videos/old.mp4","destination":"videos/folder/new.mp4"}
func (s *Server) handleMoveFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Source      string `json:"source"`
		Destination string `json:"destination"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Source == "" || body.Destination == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "source and destination are required")
		return
	}
	if !isValidMinIOKey(body.Source) || !isValidMinIOKey(body.Destination) {
		writeError(w, http.StatusBadRequest, "invalid_key", "invalid source or destination")
		return
	}
	if isSelfMove(body.Source, body.Destination) {
		writeError(w, http.StatusBadRequest, "self_move", "cannot move a folder into itself")
		return
	}
	dst := minio.CopyDestOptions{Bucket: s.config.MinioVideoBucket, Object: body.Destination}
	src := minio.CopySrcOptions{Bucket: s.config.MinioVideoBucket, Object: body.Source}
	if _, err := s.minio.CopyObject(context.Background(), dst, src); err != nil {
		writeError(w, http.StatusInternalServerError, "copy_error", err.Error())
		return
	}
	if err := s.minio.RemoveObject(context.Background(), s.config.MinioVideoBucket, body.Source, minio.RemoveObjectOptions{}); err != nil {
		writeError(w, http.StatusInternalServerError, "delete_source_error", err.Error())
		return
	}
	fileURL := fmt.Sprintf("/api/v1/videos/stream/%s", body.Destination)
	writeJSON(w, http.StatusOK, map[string]interface{}{"key": body.Destination, "url": fileURL})
}

// POST /api/v1/files/copy
// Body: {"source":"videos/file.mp4","destination":"videos/copy.mp4"}
func (s *Server) handleCopyFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Source      string `json:"source"`
		Destination string `json:"destination"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Source == "" || body.Destination == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "source and destination are required")
		return
	}
	dst := minio.CopyDestOptions{Bucket: s.config.MinioVideoBucket, Object: body.Destination}
	src := minio.CopySrcOptions{Bucket: s.config.MinioVideoBucket, Object: body.Source}
	if _, err := s.minio.CopyObject(context.Background(), dst, src); err != nil {
		writeError(w, http.StatusInternalServerError, "copy_error", err.Error())
		return
	}
	fileURL := fmt.Sprintf("/api/v1/videos/stream/%s", body.Destination)
	writeJSON(w, http.StatusOK, map[string]interface{}{"key": body.Destination, "url": fileURL})
}

// GET /api/v1/files/info?key=videos/file.mp4
// Returns ffprobe metadata for a MinIO object. Fail-soft: returns N/A fields on error.
func (s *Server) handleFileInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("key")
	if key == "" || !isValidMinIOKey(key) {
		writeError(w, http.StatusBadRequest, "invalid_key", "key required")
		return
	}

	streamURL := fmt.Sprintf("http://%s/%s/%s", s.config.MinioEndpoint, s.config.MinioVideoBucket, key)

	type VideoInfo struct {
		Resolution string `json:"resolution"`
		Bitrate    string `json:"bitrate"`
		Duration   string `json:"duration"`
		VideoCodec string `json:"video_codec"`
		AudioCodec string `json:"audio_codec"`
		Size       string `json:"size"`
	}

	info := VideoInfo{Resolution: "N/A", Bitrate: "N/A", Duration: "N/A", VideoCodec: "N/A", AudioCodec: "N/A", Size: "N/A"}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_streams",
		"-show_format",
		streamURL,
	)
	out, err := cmd.Output()
	if err == nil {
		var probe struct {
			Streams []struct {
				CodecType string `json:"codec_type"`
				CodecName string `json:"codec_name"`
				Width     int    `json:"width"`
				Height    int    `json:"height"`
				BitRate   string `json:"bit_rate"`
			} `json:"streams"`
			Format struct {
				Duration string `json:"duration"`
				Size     string `json:"size"`
				BitRate  string `json:"bit_rate"`
			} `json:"format"`
		}
		if json.Unmarshal(out, &probe) == nil {
			if dur, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
				h := int(dur) / 3600
				m := (int(dur) % 3600) / 60
				sec := int(dur) % 60
				if h > 0 {
					info.Duration = fmt.Sprintf("%d:%02d:%02d", h, m, sec)
				} else {
					info.Duration = fmt.Sprintf("%d:%02d", m, sec)
				}
			}
			if sz, err := strconv.ParseInt(probe.Format.Size, 10, 64); err == nil {
				switch {
				case sz >= 1<<30:
					info.Size = fmt.Sprintf("%.2f ГБ", float64(sz)/(1<<30))
				case sz >= 1<<20:
					info.Size = fmt.Sprintf("%.1f МБ", float64(sz)/(1<<20))
				default:
					info.Size = fmt.Sprintf("%d КБ", sz>>10)
				}
			}
			if br, err := strconv.ParseInt(probe.Format.BitRate, 10, 64); err == nil {
				info.Bitrate = fmt.Sprintf("%d кбит/с", br/1000)
			}
			for _, st := range probe.Streams {
				switch st.CodecType {
				case "video":
					info.VideoCodec = st.CodecName
					if st.Width > 0 && st.Height > 0 {
						info.Resolution = fmt.Sprintf("%dx%d", st.Width, st.Height)
					}
				case "audio":
					if info.AudioCodec == "N/A" {
						info.AudioCodec = st.CodecName
					}
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, info)
}

// GET /api/v1/videos/qualities?key=videos/file.mp4
// Returns available transcoded quality variants for a video file.
// Checks for: HLS adaptive (hls/{key}/master.m3u8) and MP4 variants (videos/{key}/output.mp4).
func (s *Server) handleVideoQualities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("key")
	if key == "" || !isValidMinIOKey(key) {
		writeError(w, http.StatusBadRequest, "invalid_key", "key required")
		return
	}

	ctx := r.Context()
	type QualityItem struct {
		Label  string `json:"label"`
		URL    string `json:"url"`
		Type   string `json:"type"` // "hls" or "mp4"
		Preset string `json:"preset"`
	}
	var qualities []QualityItem

	// Check for HLS adaptive master playlist: hls/{key}/master.m3u8
	hlsMasterKey := fmt.Sprintf("hls/%s/master.m3u8", key)
	if _, err := s.minio.StatObject(ctx, s.config.MinioVideoBucket, hlsMasterKey, minio.StatObjectOptions{}); err == nil {
		qualities = append(qualities, QualityItem{
			Label:  "HLS Adaptive",
			URL:    fmt.Sprintf("/api/v1/videos/stream/%s", hlsMasterKey),
			Type:   "hls",
			Preset: "hls_adaptive",
		})
	}

	// Check for transcoded MP4 variants: videos/{key}/output.mp4
	mp4Key := fmt.Sprintf("videos/%s/output.mp4", key)
	if obj, err := s.minio.StatObject(ctx, s.config.MinioVideoBucket, mp4Key, minio.StatObjectOptions{}); err == nil {
		sizeLabel := ""
		if obj.Size > 0 {
			sizeLabel = fmt.Sprintf(" (%.0f MB)", float64(obj.Size)/1024/1024)
		}
		qualities = append(qualities, QualityItem{
			Label:  "MP4 Transcoded" + sizeLabel,
			URL:    fmt.Sprintf("/api/v1/videos/stream/%s", mp4Key),
			Type:   "mp4",
			Preset: "mp4_transcoded",
		})
	}

	// Original file
	origURL := fmt.Sprintf("/api/v1/videos/stream/%s", key)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"key":          key,
		"original_url": origURL,
		"qualities":    qualities,
		"has_variants": len(qualities) > 0,
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy Upstream Registry — CRUD API
// ─────────────────────────────────────────────────────────────────────────────

type ProxyUpstream struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Type        string          `json:"type"` // direct|http_proxy|socks5|flaresolverr
	Endpoint    string          `json:"endpoint"`
	Auth        json.RawMessage `json:"auth"`
	Rules       json.RawMessage `json:"rules"`
	ChainIDs    json.RawMessage `json:"chain_ids"` // ordered upstream IDs to tunnel through first
	Priority    int             `json:"priority"`
	Enabled     bool            `json:"enabled"`
	CreatedAt   string          `json:"created_at,omitempty"`
	UpdatedAt   string          `json:"updated_at,omitempty"`
}

// httpConnectDialer tunnels through an HTTP CONNECT proxy, itself reachable via upstream.
type httpConnectDialer struct {
	proxyHost string // host:port of the HTTP proxy
	upstream  proxy.Dialer
}

func (d *httpConnectDialer) Dial(network, addr string) (net.Conn, error) {
	conn, err := d.upstream.Dial("tcp", d.proxyHost)
	if err != nil {
		return nil, fmt.Errorf("connect to http proxy %s: %w", d.proxyHost, err)
	}
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", addr, addr)
	if _, err = conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if !strings.Contains(string(buf[:n]), "200") {
		conn.Close()
		return nil, fmt.Errorf("http CONNECT rejected: %s", strings.SplitN(string(buf[:n]), "\r\n", 2)[0])
	}
	return conn, nil
}

// buildDialerStack stacks upstreams as tunnel hops; upstreams[0] is outermost (connects first).
// Returns the resulting proxy.Dialer. Only socks5 and http_proxy types are transport-stackable.
func buildDialerStack(upstreams []*ProxyUpstream) proxy.Dialer {
	var d proxy.Dialer = proxy.Direct
	for _, u := range upstreams {
		switch u.Type {
		case "socks5":
			var auth *proxy.Auth
			var authMap map[string]string
			if json.Unmarshal(u.Auth, &authMap) == nil && authMap["username"] != "" {
				auth = &proxy.Auth{User: authMap["username"], Password: authMap["password"]}
			}
			if next, err := proxy.SOCKS5("tcp", u.Endpoint, auth, d); err == nil {
				d = next
			}
		case "http_proxy":
			host := u.Endpoint
			if parsed, err := url.Parse(host); err == nil && parsed.Host != "" {
				host = parsed.Host
			}
			d = &httpConnectDialer{proxyHost: host, upstream: d}
		}
	}
	return d
}

// buildChainedTransport creates an http.Transport that dials through chain upstreams first,
// then through the final upstream. Chain upstreams must all be socks5 or http_proxy.
func buildChainedTransport(chainUps []*ProxyUpstream, final *ProxyUpstream) *http.Transport {
	base := &http.Transport{
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		DisableCompression: true,
	}
	chainDialer := buildDialerStack(chainUps)
	switch final.Type {
	case "socks5":
		var auth *proxy.Auth
		var authMap map[string]string
		if json.Unmarshal(final.Auth, &authMap) == nil && authMap["username"] != "" {
			auth = &proxy.Auth{User: authMap["username"], Password: authMap["password"]}
		}
		if d, err := proxy.SOCKS5("tcp", final.Endpoint, auth, chainDialer); err == nil {
			base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				return d.Dial(network, addr)
			}
		}
	case "http_proxy":
		// chain dials to the HTTP proxy; the transport then uses proxy for CONNECT/plain http
		proxyURL, _ := url.Parse(final.Endpoint)
		base.Proxy = http.ProxyURL(proxyURL)
		base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return chainDialer.Dial(network, addr)
		}
	default:
		// direct or flaresolverr: use chain dialers to reach the internet / the API endpoint
		base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return chainDialer.Dial(network, addr)
		}
	}
	return base
}

// loadChainUpstreams resolves the chain_ids of u into ordered *ProxyUpstream slices.
func (s *Server) loadChainUpstreams(ctx context.Context, u *ProxyUpstream) []*ProxyUpstream {
	if len(u.ChainIDs) == 0 || string(u.ChainIDs) == "null" || string(u.ChainIDs) == "[]" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal(u.ChainIDs, &ids); err != nil || len(ids) == 0 {
		return nil
	}
	var result []*ProxyUpstream
	for _, id := range ids {
		var cu ProxyUpstream
		var auth, rules, chainIDs []byte
		err := s.db.QueryRow(ctx,
			`SELECT id, name, type, endpoint, auth, rules, chain_ids FROM proxy_upstreams WHERE id=$1`, id,
		).Scan(&cu.ID, &cu.Name, &cu.Type, &cu.Endpoint, &auth, &rules, &chainIDs)
		if err != nil {
			continue
		}
		cu.Auth = json.RawMessage(auth)
		cu.Rules = json.RawMessage(rules)
		cu.ChainIDs = json.RawMessage(chainIDs)
		result = append(result, &cu)
	}
	return result
}

// buildClientForUpstream creates an http.Client for u, building a chained transport if needed.
func (s *Server) buildClientForUpstream(ctx context.Context, u *ProxyUpstream) *http.Client {
	chainUps := s.loadChainUpstreams(ctx, u)
	var transport *http.Transport
	if len(chainUps) > 0 {
		transport = buildChainedTransport(chainUps, u)
	} else {
		transport = buildProxyTransport(u)
	}
	return &http.Client{Transport: transport}
}

// ── Forward proxy (browser/app HTTP proxy) ────────────────────────────────────
// Clients point their browser (or phone) at the forward proxy port and ALL
// traffic is routed through the upstream registry (socks5/http_proxy chains).
// This is how YouTube is watched from RU with each user's OWN account: the
// user's browser keeps its own YouTube cookies; the server merely tunnels the
// bytes to YouTube via a non-RU egress (the socks5 upstream on NB1/NB2).
// Per-user auth state stays client-side — the server never sees credentials.

// forwardProxyHandler is the entry point for the forward proxy listener.
// It supports CONNECT (HTTPS tunneling) and plain absolute-URI HTTP requests.
func (s *Server) forwardProxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		s.handleForwardConnect(w, r)
		return
	}
	// Forward proxies require absolute-URI request-targets (RFC 7230 §5.3.2).
	if !r.URL.IsAbs() {
		http.Error(w, "Forward proxy requires absolute URL", http.StatusBadRequest)
		return
	}
	_, client := s.selectUpstream(r.Context(), r.URL.String())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Header = r.Header.Clone()
	req.Header.Del("Proxy-Connection")
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// handleForwardConnect establishes a raw TCP tunnel (CONNECT) for HTTPS traffic,
// dialing the target through the upstream selected for that host.
func (s *Server) handleForwardConnect(w http.ResponseWriter, r *http.Request) {
	target := r.Host
	if target == "" {
		http.Error(w, "CONNECT requires host", http.StatusBadRequest)
		return
	}
	dialer := s.dialerForTarget(r.Context(), target)
	upstreamConn, err := dialer.Dial("tcp", target)
	if err != nil {
		http.Error(w, "CONNECT failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstreamConn.Close()
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, buf, err := hj.Hijack()
	if err != nil {
		upstreamConn.Close()
		http.Error(w, "Hijack failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := buf.WriteString("HTTP/1.1 200 Connection established\x0d\x0a\x0d\x0a"); err != nil {
		clientConn.Close()
		upstreamConn.Close()
		return
	}
	if err := buf.Flush(); err != nil {
		clientConn.Close()
		upstreamConn.Close()
		return
	}
	// Bidirectional byte pump. Close both when either side finishes.
	go func() { io.Copy(upstreamConn, clientConn); upstreamConn.Close(); }()
	go func() { io.Copy(clientConn, upstreamConn); clientConn.Close(); }()
}

// dialerForTarget returns the proxy.Dialer to reach `target` (host:port):
// the selected upstream + its chain (socks5/http_proxy), or proxy.Direct.
func (s *Server) dialerForTarget(ctx context.Context, target string) proxy.Dialer {
	upstream, _ := s.selectUpstream(ctx, "https://"+target)
	if upstream == nil || upstream.Type == "direct" || upstream.Type == "flaresolverr" {
		return proxy.Direct
	}
	stack := s.loadChainUpstreams(ctx, upstream)
	if upstream.Type == "socks5" || upstream.Type == "http_proxy" {
		stack = append(stack, upstream) // final upstream is closest to the target
	}
	if len(stack) == 0 {
		return proxy.Direct
	}
	return buildDialerStack(stack)
}

// copyHeader copies all header values from src to dst.
func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// ytdlpProxyArgs returns yt-dlp --proxy arguments for a target URL, or nil when
// no proxy upstream matches (then yt-dlp connects directly). Includes the
// upstream's auth credentials (socks5/http_proxy may require user:pass).
func (s *Server) ytdlpProxyArgs(ctx context.Context, targetURL string) []string {
	u, _ := s.selectUpstream(ctx, targetURL)
	if u == nil || (u.Type != "socks5" && u.Type != "http_proxy") {
		return nil
	}
	endpoint := u.Endpoint
	if u.Type == "socks5" && !strings.HasPrefix(endpoint, "socks5://") && !strings.HasPrefix(endpoint, "socks5h://") {
		endpoint = "socks5://" + endpoint
	}
	var authMap map[string]string
	if json.Unmarshal(u.Auth, &authMap) == nil && authMap["username"] != "" {
		pu, err := url.Parse(endpoint)
		if err == nil {
			pu.User = url.UserPassword(authMap["username"], authMap["password"])
			endpoint = pu.String()
		}
	}
	return []string{"--proxy", endpoint}
}

var validUpstreamTypes = map[string]bool{
	"direct":       true,
	"http_proxy":   true,
	"socks5":       true,
	"flaresolverr": true,
}

// GET/POST /api/v1/proxy/upstreams
func (s *Server) handleProxyUpstreams(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listProxyUpstreams(w, r)
	case http.MethodPost:
		s.createProxyUpstream(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) listProxyUpstreams(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT id, name, description, type, endpoint, auth, rules, chain_ids, priority, enabled, created_at, updated_at
		 FROM proxy_upstreams ORDER BY priority ASC, created_at ASC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	defer rows.Close()
	upstreams := []ProxyUpstream{}
	for rows.Next() {
		var u ProxyUpstream
		var auth, rules, chainIDs []byte
		var createdAt, updatedAt interface{}
		if err := rows.Scan(&u.ID, &u.Name, &u.Description, &u.Type, &u.Endpoint,
			&auth, &rules, &chainIDs, &u.Priority, &u.Enabled, &createdAt, &updatedAt); err != nil {
			continue
		}
		u.Auth = json.RawMessage(auth)
		u.Rules = json.RawMessage(rules)
		u.ChainIDs = json.RawMessage(chainIDs)
		if createdAt != nil {
			u.CreatedAt = fmt.Sprintf("%v", createdAt)
		}
		if updatedAt != nil {
			u.UpdatedAt = fmt.Sprintf("%v", updatedAt)
		}
		upstreams = append(upstreams, u)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"upstreams": upstreams})
}

func (s *Server) createProxyUpstream(w http.ResponseWriter, r *http.Request) {
	var u ProxyUpstream
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if u.Name == "" {
		writeError(w, http.StatusBadRequest, "validation", "name required")
		return
	}
	if !validUpstreamTypes[u.Type] {
		writeError(w, http.StatusBadRequest, "validation", "invalid type; allowed: direct, http_proxy, socks5, flaresolverr")
		return
	}
	if u.Auth == nil {
		u.Auth = json.RawMessage("{}")
	}
	if u.Rules == nil {
		u.Rules = json.RawMessage("[]")
	}
	if u.ChainIDs == nil {
		u.ChainIDs = json.RawMessage("[]")
	}
	var id string
	err := s.db.QueryRow(r.Context(),
		`INSERT INTO proxy_upstreams (name, description, type, endpoint, auth, rules, chain_ids, priority, enabled)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		u.Name, u.Description, u.Type, u.Endpoint, []byte(u.Auth), []byte(u.Rules), []byte(u.ChainIDs), u.Priority, u.Enabled,
	).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	u.ID = id
	writeJSON(w, http.StatusCreated, u)
}

// PUT /api/v1/proxy/upstreams/{id}
// DELETE /api/v1/proxy/upstreams/{id}
func (s *Server) handleProxyUpstream(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/proxy/upstreams/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "upstream id required")
		return
	}
	switch r.Method {
	case http.MethodPut:
		s.updateProxyUpstream(w, r, id)
	case http.MethodDelete:
		s.deleteProxyUpstream(w, r, id)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) updateProxyUpstream(w http.ResponseWriter, r *http.Request, id string) {
	var u ProxyUpstream
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if u.Name == "" {
		writeError(w, http.StatusBadRequest, "validation", "name required")
		return
	}
	if !validUpstreamTypes[u.Type] {
		writeError(w, http.StatusBadRequest, "validation", "invalid type")
		return
	}
	if u.Auth == nil {
		u.Auth = json.RawMessage("{}")
	}
	if u.Rules == nil {
		u.Rules = json.RawMessage("[]")
	}
	if u.ChainIDs == nil {
		u.ChainIDs = json.RawMessage("[]")
	}
	tag, err := s.db.Exec(r.Context(),
		`UPDATE proxy_upstreams SET name=$1, description=$2, type=$3, endpoint=$4, auth=$5, rules=$6,
		 chain_ids=$7, priority=$8, enabled=$9, updated_at=NOW() WHERE id=$10`,
		u.Name, u.Description, u.Type, u.Endpoint, []byte(u.Auth), []byte(u.Rules), []byte(u.ChainIDs), u.Priority, u.Enabled, id,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not_found", "upstream not found")
		return
	}
	u.ID = id
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) deleteProxyUpstream(w http.ResponseWriter, r *http.Request, id string) {
	tag, err := s.db.Exec(r.Context(), `DELETE FROM proxy_upstreams WHERE id=$1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not_found", "upstream not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/v1/proxy/upstreams/{id}/test
// Tests an upstream by making a HEAD request to https://example.com through it.
func (s *Server) handleProxyUpstreamTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/proxy/upstreams/")
	id = strings.TrimSuffix(id, "/test")
	var u ProxyUpstream
	err := s.db.QueryRow(r.Context(),
		`SELECT id, type, endpoint FROM proxy_upstreams WHERE id=$1`, id,
	).Scan(&u.ID, &u.Type, &u.Endpoint)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "upstream not found")
		return
	}
	ok, latencyMs, testErr := s.testUpstream(r.Context(), &u)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":         ok,
		"latency_ms": latencyMs,
		"error":      testErr,
		"upstream":   u.ID,
	})
}

func (s *Server) testUpstream(ctx context.Context, u *ProxyUpstream) (bool, int64, string) {
	testURL := "https://example.com"
	var transport *http.Transport

	switch u.Type {
	case "direct", "flaresolverr":
		transport = &http.Transport{}
	case "http_proxy":
		proxyURL, err := url.Parse(u.Endpoint)
		if err != nil {
			return false, 0, "invalid proxy endpoint: " + err.Error()
		}
		transport = &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	case "socks5":
		// Basic SOCKS5 test — just TCP connect
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(u.Endpoint, "socks5://"), 5*time.Second)
		if err != nil {
			return false, 0, err.Error()
		}
		conn.Close()
		return true, 0, ""
	default:
		return false, 0, "unknown type"
	}

	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, testURL, nil)
	resp, err := client.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return false, 0, err.Error()
	}
	resp.Body.Close()
	return resp.StatusCode < 500, elapsed, ""
}

// buildProxyTransport creates an http.Transport for the given upstream type (no chaining).
func buildProxyTransport(u *ProxyUpstream) *http.Transport {
	base := &http.Transport{
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		DisableCompression: true,
	}
	switch u.Type {
	case "http_proxy":
		if proxyURL, err := url.Parse(u.Endpoint); err == nil {
			base.Proxy = http.ProxyURL(proxyURL)
		}
	case "socks5":
		var auth *proxy.Auth
		var authMap map[string]string
		if json.Unmarshal(u.Auth, &authMap) == nil && authMap["username"] != "" {
			auth = &proxy.Auth{User: authMap["username"], Password: authMap["password"]}
		}
		if d, err := proxy.SOCKS5("tcp", u.Endpoint, auth, proxy.Direct); err == nil {
			base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				return d.Dial(network, addr)
			}
		}
	}
	return base
}

// selectUpstream picks the best upstream for a target URL based on rules stored in DB.
// Returns the upstream and a client built for it. Falls back to "direct" on error.
func (s *Server) selectUpstream(ctx context.Context, targetURL string) (*ProxyUpstream, *http.Client) {
	direct := &ProxyUpstream{ID: "direct", Name: "Direct", Type: "direct"}
	directClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:    &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
			DisableCompression: true,
		},
	}
	if s.db == nil {
		return direct, directClient
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, name, type, endpoint, auth, rules, chain_ids FROM proxy_upstreams
		 WHERE enabled=TRUE ORDER BY priority ASC, created_at ASC`)
	if err != nil {
		return direct, directClient
	}
	defer rows.Close()

	parsed, _ := url.Parse(targetURL)
	host := ""
	if parsed != nil {
		host = parsed.Host
	}

	for rows.Next() {
		var u ProxyUpstream
		var authRaw, rulesRaw, chainIDsRaw []byte
		if err := rows.Scan(&u.ID, &u.Name, &u.Type, &u.Endpoint, &authRaw, &rulesRaw, &chainIDsRaw); err != nil {
			continue
		}
		u.Auth = json.RawMessage(authRaw)
		u.ChainIDs = json.RawMessage(chainIDsRaw)
		if u.Type == "direct" {
			continue // skip explicit "direct" entries — they're fallback only
		}
		// Check rules: [{url_pattern, action}]
		var rules []struct {
			URLPattern string `json:"url_pattern"`
			Action     string `json:"action"` // "use" | "skip"
		}
		if json.Unmarshal(rulesRaw, &rules) == nil && len(rules) > 0 {
			matched := false
			for _, rule := range rules {
				if rule.Action == "use" {
					if ok, _ := regexp.MatchString(rule.URLPattern, host); ok {
						matched = true
						break
					}
				}
			}
			if !matched {
				continue
			}
		}
		// Use this upstream (builds chained transport if chain_ids present)
		client := s.buildClientForUpstream(ctx, &u)
		return &u, client
	}
	return direct, directClient
}

// startHealthCheckLoop runs background health checks every 60s for all enabled upstreams.
func (s *Server) startHealthCheckLoop() {
	go func() {
		for {
			time.Sleep(60 * time.Second)
			s.runHealthChecks()
		}
	}()
}

func (s *Server) runHealthChecks() {
	if s.db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `SELECT id, name, type, endpoint FROM proxy_upstreams WHERE enabled=TRUE`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var u ProxyUpstream
		if err := rows.Scan(&u.ID, &u.Name, &u.Type, &u.Endpoint); err != nil {
			continue
		}
		go func(upstream ProxyUpstream) {
			hctx, hcancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer hcancel()
			ok, latency, errStr := s.testUpstream(hctx, &upstream)
			upstreamHealthMap.Store(upstream.ID, &UpstreamHealthStatus{
				OK:        ok,
				LatencyMs: latency,
				Error:     errStr,
				CheckedAt: time.Now(),
			})
		}(u)
	}
}

// GET /api/v1/proxy/health — returns cached health status of all upstreams
func (s *Server) handleProxyHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	result := map[string]interface{}{}
	upstreamHealthMap.Range(func(k, v interface{}) bool {
		result[k.(string)] = v
		return true
	})
	writeJSON(w, http.StatusOK, result)
}

// GET /api/v1/proxy/fetch?url={target}&via={upstream_id}
// Generic proxy endpoint that routes through the upstream registry (auto-routes if no via).
func (s *Server) handleProxyFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Range, Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		writeError(w, http.StatusBadRequest, "missing_url", "url parameter required")
		return
	}

	var upstream *ProxyUpstream
	var proxyClient *http.Client

	viaID := r.URL.Query().Get("via")
	if viaID != "" && s.db != nil {
		// Explicit upstream selection
		var u ProxyUpstream
		var authRaw, rulesRaw, chainIDsRaw []byte
		err := s.db.QueryRow(r.Context(),
			`SELECT id, name, type, endpoint, auth, rules, chain_ids FROM proxy_upstreams WHERE id=$1 AND enabled=TRUE`, viaID,
		).Scan(&u.ID, &u.Name, &u.Type, &u.Endpoint, &authRaw, &rulesRaw, &chainIDsRaw)
		if err == nil {
			u.Auth = json.RawMessage(authRaw)
			u.ChainIDs = json.RawMessage(chainIDsRaw)
			upstream = &u
			proxyClient = s.buildClientForUpstream(r.Context(), &u)
		}
	}
	if upstream == nil {
		upstream, proxyClient = s.selectUpstream(r.Context(), targetURL)
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_url", err.Error())
		return
	}
	if rangeH := r.Header.Get("Range"); rangeH != "" {
		req.Header.Set("Range", rangeH)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Accept", "*/*")

	start := time.Now()
	proxyUpstreamRequests.WithLabelValues(upstream.ID, upstream.Name).Inc()

	resp, err := proxyClient.Do(req)
	elapsed := time.Since(start).Seconds()
	proxyUpstreamDuration.WithLabelValues(upstream.ID, upstream.Name).Observe(elapsed)
	if err != nil {
		proxyUpstreamErrors.WithLabelValues(upstream.ID, upstream.Name).Inc()
		writeError(w, http.StatusBadGateway, "fetch_error", err.Error())
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("X-Proxy-Upstream", upstream.Name)
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	written, _ := io.Copy(w, resp.Body)
	proxyUpstreamBytes.WithLabelValues(upstream.ID, upstream.Name).Add(float64(written))
}

// POST /api/v1/files/fm-upload?prefix=videos/folder/
// Uploads a file to the given prefix path inside MinIO.
func (s *Server) handleFMUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Accept prefix from query param or x-folder-path header (header takes precedence)
	prefix := r.Header.Get("x-folder-path")
	if prefix == "" {
		prefix = r.URL.Query().Get("prefix")
	}
	if prefix == "" {
		prefix = "videos/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if !isValidMinIOKey(prefix) {
		writeError(w, http.StatusBadRequest, "invalid_prefix", "invalid upload prefix")
		return
	}
	r.ParseMultipartForm(32 << 10) // minimal in-memory; large files stream to disk
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "no_file", "No file provided")
		return
	}
	defer file.Close()

	objectName := prefix + header.Filename
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	// Use -1 as size when header.Size is 0 (unknown) to allow streaming upload
	objectSize := header.Size
	if objectSize == 0 {
		objectSize = -1
	}
	if _, err = s.minio.PutObject(context.Background(),
		s.config.MinioVideoBucket, objectName, file, objectSize,
		minio.PutObjectOptions{ContentType: contentType},
	); err != nil {
		log.Printf("handleFMUpload PutObject error for %s: %v", objectName, err)
		writeError(w, http.StatusInternalServerError, "upload_error", err.Error())
		return
	}
	fileURL := fmt.Sprintf("/api/v1/videos/stream/%s", objectName)
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"key": objectName, "url": fileURL, "filename": header.Filename,
		"size": header.Size, "content_type": contentType,
	})
}

// ── end File Manager handlers ─────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Stream Cacher
// ─────────────────────────────────────────────────────────────────────────────

type CacheJob struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Title     string    `json:"title"`
	Status    string    `json:"status"` // pending, downloading, done, error
	Progress  int       `json:"progress"`
	CachedURL string    `json:"cached_url,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

var cacheJobs sync.Map // id → *CacheJob

// cacheJobSemaphore limits concurrent downloads to prevent CPU/memory exhaustion.
var cacheJobSemaphore = make(chan struct{}, 3)

const cacheJobTTL = 7 * 24 * time.Hour
const cacheJobIndexKey = "cache:jobs"

func cacheJobRedisKey(id string) string { return "cache:job:" + id }

func (s *Server) updateCacheJob(id string, fn func(*CacheJob)) {
	if v, ok := cacheJobs.Load(id); ok {
		job := v.(*CacheJob)
		fn(job)
		s.persistCacheJob(job)
	}
}

func (s *Server) persistCacheJob(job *CacheJob) {
	if s.redis == nil {
		return
	}
	data, err := json.Marshal(job)
	if err != nil {
		return
	}
	ctx := context.Background()
	s.redis.Set(ctx, cacheJobRedisKey(job.ID), data, cacheJobTTL)
	s.redis.SAdd(ctx, cacheJobIndexKey, job.ID)
	s.redis.Expire(ctx, cacheJobIndexKey, cacheJobTTL)
}

func (s *Server) deleteCacheJobFromRedis(id string) {
	if s.redis == nil {
		return
	}
	ctx := context.Background()
	s.redis.Del(ctx, cacheJobRedisKey(id))
	s.redis.SRem(ctx, cacheJobIndexKey, id)
}

func (s *Server) loadCacheJobsFromRedis() {
	if s.redis == nil {
		return
	}
	ctx := context.Background()
	ids, err := s.redis.SMembers(ctx, cacheJobIndexKey).Result()
	if err != nil {
		return
	}
	loaded := 0
	for _, id := range ids {
		data, err := s.redis.Get(ctx, cacheJobRedisKey(id)).Bytes()
		if err != nil {
			s.redis.SRem(ctx, cacheJobIndexKey, id)
			continue
		}
		var job CacheJob
		if err := json.Unmarshal(data, &job); err != nil {
			continue
		}
		// In-flight jobs can't be resumed — mark as error
		if job.Status == "downloading" || job.Status == "pending" {
			job.Status = "error"
			job.Error = "interrupted by server restart"
			data, _ = json.Marshal(&job)
			s.redis.Set(ctx, cacheJobRedisKey(id), data, cacheJobTTL)
		}
		cacheJobs.Store(id, &job)
		loaded++
	}
	if loaded > 0 {
		log.Printf("Loaded %d cache jobs from Redis", loaded)
	}
}

func (s *Server) handleStartCache(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "url required", http.StatusBadRequest)
		return
	}
	// Deduplicate: if already caching/done for this URL, return existing job
	var existing *CacheJob
	cacheJobs.Range(func(_, v any) bool {
		j := v.(*CacheJob)
		if j.URL == req.URL && j.Status != "error" {
			existing = j
			return false
		}
		return true
	})
	if existing != nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}
	id := fmt.Sprintf("%x", sha256.Sum256([]byte(req.URL+fmt.Sprint(time.Now().UnixNano()))))[:16]
	job := &CacheJob{
		ID:        id,
		URL:       req.URL,
		Title:     req.Title,
		Status:    "pending",
		Progress:  0,
		CreatedAt: time.Now(),
	}
	cacheJobs.Store(id, job)
	s.persistCacheJob(job)
	go s.runCacheJob(job)
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleListCache(w http.ResponseWriter, r *http.Request) {
	jobs := []*CacheJob{}
	cacheJobs.Range(func(_, v any) bool {
		jobs = append(jobs, v.(*CacheJob))
		return true
	})
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

func (s *Server) handleDeleteCache(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	v, ok := cacheJobs.Load(id)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	job := v.(*CacheJob)
	if job.Status == "done" {
		key := "cache/" + id + "/video" + filepath.Ext(job.CachedURL)
		s.minio.RemoveObject(context.Background(), s.config.MinioVideoBucket, key, minio.RemoveObjectOptions{})
	}
	cacheJobs.Delete(id)
	s.deleteCacheJobFromRedis(id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) runCacheJob(job *CacheJob) {
	// Acquire semaphore — block until a slot is free (max 3 concurrent downloads)
	cacheJobSemaphore <- struct{}{}
	defer func() { <-cacheJobSemaphore }()

	tmpDir := filepath.Join(os.TempDir(), "sw-cache", job.ID)
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "error"; j.Error = err.Error() })
		return
	}
	defer os.RemoveAll(tmpDir)

	s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "downloading" })

	outputFile, err := s.runYtDlp(job.ID, job.URL, tmpDir)
	if err != nil {
		ytURL := strings.Contains(job.URL, "youtube.com/") || strings.Contains(job.URL, "youtu.be/")
		if ytURL {
			// ffmpeg cannot open YouTube URLs — don't attempt fallback, surface yt-dlp error directly
			s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "error"; j.Error = "yt-dlp failed: " + err.Error() + " (убедитесь, что yt-dlp установлен в контейнере)" })
			return
		}
		// Fallback: ffmpeg for raw streams (non-YouTube)
		outputFile = filepath.Join(tmpDir, "video.mp4")
		err = s.runFfmpegDownload(job.ID, job.URL, outputFile)
	}
	if err != nil {
		s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "error"; j.Error = err.Error() })
		return
	}

	// Upload to MinIO
	ext := filepath.Ext(outputFile)
	if ext == "" {
		ext = ".mp4"
	}
	objectKey := "cache/" + job.ID + "/video" + ext
	contentType := "video/mp4"
	if ext == ".mkv" {
		contentType = "video/x-matroska"
	} else if ext == ".webm" {
		contentType = "video/webm"
	}
	f, err := os.Open(outputFile)
	if err != nil {
		s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "error"; j.Error = "open: " + err.Error() })
		return
	}
	stat, _ := f.Stat()
	size := int64(-1)
	if stat != nil {
		size = stat.Size()
	}
	_, err = s.minio.PutObject(context.Background(), s.config.MinioVideoBucket, objectKey, f, size,
		minio.PutObjectOptions{ContentType: contentType})
	f.Close()
	if err != nil {
		s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "error"; j.Error = "upload: " + err.Error() })
		return
	}

	cachedURL := "/api/v1/videos/stream/" + objectKey
	s.updateCacheJob(job.ID, func(j *CacheJob) { j.Status = "done"; j.Progress = 100; j.CachedURL = cachedURL })
}

// ytDlpProgressRe matches lines like: [download]  50.0% of   1.23GiB at    5.00MiB/s
var ytDlpProgressRe = regexp.MustCompile(`\[download\]\s+(\d+(?:\.\d+)?)%`)

func (s *Server) runYtDlp(jobID, rawURL, tmpDir string) (string, error) {
	outTemplate := filepath.Join(tmpDir, "video.%(ext)s")
	// Route YouTube/other downloads through the proxy upstream registry when
	// an upstream matches (e.g. a non-RU socks5 for RU-throttled YouTube).
	proxyArgs := s.ytdlpProxyArgs(context.Background(), rawURL)
	dlArgs := "-x16 -s16 -k1M --file-allocation=none"
	if len(proxyArgs) > 0 {
		dlArgs += " --all-proxy=" + proxyArgs[1]
	}
	args := []string{
		"--no-playlist",
		"--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
		"--merge-output-format", "mp4",
		"--concurrent-fragments", "16",
		"--downloader", "aria2c",
		"--downloader-args", "aria2c:" + dlArgs,
		"--output", outTemplate,
		"--newline",
		"--no-mtime",
		"--no-post-overwrites",
	}
	args = append(args, proxyArgs...)
	args = append(args, rawURL)
	cmd := exec.Command("yt-dlp", args...)
	cmd.Stderr = os.Stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("yt-dlp not available: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if m := ytDlpProgressRe.FindStringSubmatch(line); len(m) > 1 {
			pct, _ := strconv.ParseFloat(m[1], 64)
			s.updateCacheJob(jobID, func(j *CacheJob) { j.Progress = int(pct * 0.9) }) // 0-90% during download
		}
	}
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("yt-dlp failed: %w", err)
	}
	// Find the output file
	entries, err := os.ReadDir(tmpDir)
	if err != nil || len(entries) == 0 {
		return "", fmt.Errorf("yt-dlp produced no output")
	}
	return filepath.Join(tmpDir, entries[0].Name()), nil
}

// POST /api/v1/youtube/cookies — store the user's YouTube cookies (Netscape
// cookies.txt format) used to resolve age-restricted (18+) videos that yt-dlp
// can't fetch anonymously. Empty/absent cookies clears the stored value.
// Requires JWT (Kong youtube-cookies route).
func (s *Server) handleYTCookies(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	token := bearerToken(r)
	userID, _ := verifyStreamIdentity(token)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required")
		return
	}
	var req struct {
		Cookies string `json:"cookies"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	has := false
	if strings.TrimSpace(req.Cookies) != "" {
		_, err := s.db.Exec(context.Background(),
			`UPDATE users SET preferences = jsonb_set(COALESCE(preferences,'{}'), '{youtube_cookies}', to_jsonb($1::text)) WHERE id = $2`,
			req.Cookies, userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to save cookies")
			return
		}
		has = true
	} else {
		_, err := s.db.Exec(context.Background(),
			`UPDATE users SET preferences = COALESCE(preferences,'{}'::jsonb) - 'youtube_cookies' WHERE id = $1`,
			userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "db_error", "Failed to clear cookies")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "saved", "has_cookies": has})
}

// youtubeCookiesFile returns a path to the user's stored YouTube cookies file
// (if any), writing it to a temp file for yt-dlp --cookies. Empty string = none.
func (s *Server) youtubeCookiesFile(ctx context.Context, userID string) string {
	if userID == "" {
		return ""
	}
	var ck string
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(preferences->>'youtube_cookies','') FROM users WHERE id = $1`, userID,
	).Scan(&ck)
	if err != nil || strings.TrimSpace(ck) == "" {
		return ""
	}
	cf := filepath.Join("/tmp/sw-cache", "yt-cookies-"+userID+".txt")
	if err := os.WriteFile(cf, []byte(ck), 0600); err != nil {
		log.Printf("youtube cookies: cannot write %s: %v", cf, err)
		return ""
	}
	return cf
}

// GET /api/v1/videos/resolve-stream?url=<twitch|youtube>
// Resolves a page URL (Twitch channel/VOD, YouTube live) to a direct playable
// stream URL (HLS m3u8) via `yt-dlp -g` — no download, just URL resolution.
func (s *Server) handleResolveStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		writeError(w, http.StatusBadRequest, "missing_url", "url parameter required")
		return
	}

	// SSRF guard — only allow Twitch / YouTube hosts.
	parsed, err := url.Parse(targetURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_url", "Invalid URL")
		return
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "twitch.tv" && host != "www.twitch.tv" && host != "youtube.com" && host != "www.youtube.com" && host != "youtu.be" {
		writeError(w, http.StatusBadRequest, "unsupported_url", "Only Twitch and YouTube URLs are supported")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Optional per-user YouTube cookies for age-restricted (18+) videos that
	// yt-dlp can't fetch anonymously. Caller passes cookies=1 + JWT; the stored
	// cookies file is written to a temp path and passed to yt-dlp --cookies.
	cookieFile := ""
	if r.URL.Query().Get("cookies") == "1" {
		if token := bearerToken(r); token != "" {
			if uid, _ := verifyStreamIdentity(token); uid != "" {
				cookieFile = s.youtubeCookiesFile(ctx, uid)
			}
		}
	}

	args := []string{"--no-playlist", "-g"}
	if host == "youtube.com" || host == "www.youtube.com" || host == "youtu.be" {
		args = append(args, "--extractor-args", "youtube:player_client=android")
		args = append(args, "-f", "22/18/best[ext=mp4]/best")
		args = append(args, "--age-limit", "99")
	}
	if cookieFile != "" {
		args = append(args, "--cookies", cookieFile)
	}
	args = append(args, s.ytdlpProxyArgs(ctx, targetURL)...)
	args = append(args, targetURL)
	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	out, err := cmd.Output()
	if err != nil {
		// Capture yt-dlp's stderr (e.g. "channel is not currently live").
		msg := err.Error()
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			msg = strings.TrimSpace(string(exitErr.Stderr))
		}
		// Channel offline is a client-visible condition, not a server fault. Use 422
		// so the frontend nginx (which rewrites 502/503/504 bodies) passes it through.
		code := "resolve_error"
		if strings.Contains(strings.ToLower(msg), "not live") || strings.Contains(strings.ToLower(msg), "not currently live") {
			code = "channel_offline"
		}
		writeError(w, http.StatusUnprocessableEntity, code, msg)
		return
	}

	// yt-dlp -g may print several URLs; take the last (usually the m3u8 / best).
	streamURL := ""
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if t := strings.TrimSpace(line); t != "" {
			streamURL = t
		}
	}
	if streamURL == "" {
		writeError(w, http.StatusBadGateway, "resolve_error", "No stream URL returned")
		return
	}

	streamType := "direct"
	if strings.Contains(streamURL, ".m3u8") {
		streamType = "hls"
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"stream_url": streamURL,
		"type":       streamType,
	})
}

// GET /api/v1/youtube/shorts?channel=@channelname&max=20
// Fetches YouTube Shorts from a channel using yt-dlp flat-playlist (fast, no download).
func (s *Server) handleYTShortsFeed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "shorts" // fallback: trending shorts via hashtag
	}
	maxStr := r.URL.Query().Get("max")
	maxResults := 20
	if n, err := strconv.Atoi(maxStr); err == nil && n > 0 && n <= 50 {
		maxResults = n
	}

	url := "https://www.youtube.com/" + channel + "/shorts"
	if !strings.HasPrefix(channel, "@") {
		url = "https://www.youtube.com/hashtag/" + channel
	}

	args := []string{
		"--flat-playlist",
		"--print", "%(id)s|%(title)s|%(duration)s",
		"--no-warnings",
		"--playlist-end", strconv.Itoa(maxResults),
	}
	args = append(args, s.ytdlpProxyArgs(r.Context(), url)...)
	args = append(args, url)
	cmd := exec.Command("yt-dlp", args...)
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		log.Printf("shorts: yt-dlp error for %s: %v", channel, err)
		writeError(w, http.StatusBadGateway, "yt_dlp_error", "Failed to fetch shorts: "+err.Error())
		return
	}
	outStr := strings.TrimSpace(string(out))
	log.Printf("shorts: yt-dlp returned %d bytes for %s", len(outStr), channel)

	type ShortItem struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		URL       string `json:"url"`
		Thumbnail string `json:"thumbnail"`
		Duration  int    `json:"duration"`
	}
	var shorts []ShortItem
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "|", 3)
		if len(parts) < 2 {
			continue
		}
		dur := 0
		if len(parts) > 2 {
			if f, e := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64); e == nil {
				dur = int(f)
			}
		}
		shorts = append(shorts, ShortItem{
			ID:        parts[0],
			Title:     parts[1],
			URL:       "https://www.youtube.com/shorts/" + parts[0],
			Thumbnail: "https://img.youtube.com/vi/" + parts[0] + "/mqdefault.jpg",
			Duration:  dur,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"shorts": shorts,
		"source": channel,
	})
}

// ffmpegProgressRe matches: out_time_us=1234567
var ffmpegProgressRe = regexp.MustCompile(`out_time_us=(\d+)`)

// ffmpegDurationRe matches: Duration: HH:MM:SS.ms in stderr
var ffmpegDurationRe = regexp.MustCompile(`Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)`)

func (s *Server) runFfmpegDownload(jobID, rawURL, outputFile string) error {
	args := []string{
		"-i", rawURL,
		"-c", "copy",
		"-movflags", "+faststart",
		"-progress", "pipe:1",
		"-y",
		outputFile,
	}
	cmd := exec.Command("ffmpeg", args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("ffmpeg not available: %w", err)
	}

	var totalUs int64
	// Parse duration from stderr after process ends (it's printed early)
	go func() {
		// Read stderr asynchronously; duration appears in first few lines
		buf := make([]byte, 4096)
		for {
			n, err := stderrBuf.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				if totalUs == 0 {
					if m := ffmpegDurationRe.FindStringSubmatch(chunk); len(m) > 3 {
						h, _ := strconv.ParseFloat(m[1], 64)
						min, _ := strconv.ParseFloat(m[2], 64)
						sec, _ := strconv.ParseFloat(m[3], 64)
						totalUs = int64((h*3600+min*60+sec) * 1e6)
					}
				}
			}
			if err != nil {
				break
			}
		}
	}()

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if totalUs > 0 {
			if m := ffmpegProgressRe.FindStringSubmatch(line); len(m) > 1 {
				us, _ := strconv.ParseInt(m[1], 10, 64)
				pct := float64(us) / float64(totalUs) * 90 // 0–90% during download
				if pct > 90 {
					pct = 90
				}
				s.updateCacheJob(jobID, func(j *CacheJob) { j.Progress = int(pct) })
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg failed: %s — %w", stderrBuf.String(), err)
	}
	return nil
}

func main() {
	config := &Config{
		Port:             getEnv("PORT", "8080"),
		DBHost:           getEnv("DB_HOST", "localhost"),
		DBPort:           getEnv("DB_PORT", "5432"),
		DBUser:           getEnv("DB_USER", "watchsync"),
		DBPassword:       getEnv("DB_PASSWORD", "changeme"),
		DBName:           getEnv("DB_NAME", "watchsync"),
		DBSSLMode:        getEnv("DB_SSL_MODE", "disable"),
		MinioEndpoint:    getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:   getEnv("MINIO_ACCESS_KEY", "minioadmin"),
		MinioSecretKey:   getEnv("MINIO_SECRET_KEY", "minioadmin"),
		MinioVideoBucket: getEnv("MINIO_BUCKET_VIDEOS", "videos"),
		YoutubeAPIKey:    getEnv("YOUTUBE_API_KEY", ""),
		MaxQueueSize:     100,
		NatsURL:          getEnv("NATS_URL", "nats://nats:4222"),
		RedisHost:        getEnv("REDIS_HOST", "redis"),
		RedisPort:        getEnv("REDIS_PORT", "6379"),
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	go server.startHealthCheckLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/rooms/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/proxy-url"):
			server.handleProxyURL(w, r)
		case strings.Contains(path, "/proxy-config"):
			server.handleProxyConfig(w, r)
		case strings.Contains(path, "/queue"):
			if r.Method == http.MethodDelete {
				server.handleRemoveFromQueue(w, r)
			} else if r.Method == http.MethodGet {
				server.handleGetQueue(w, r)
			} else if r.Method == http.MethodPost {
				server.handleAddToQueue(w, r)
			} else if r.Method == http.MethodPatch {
				server.handleReorderQueue(w, r)
			}
		}
	})
	mux.HandleFunc("/api/v1/embed/extract", server.handleExtractEmbed)
	mux.HandleFunc("/api/v1/videos/upload", server.handleUpload)
	mux.HandleFunc("/api/v1/videos/stream/", server.handleStreamVideo)
	mux.HandleFunc("/api/v1/videos/prebuffer/", server.handlePrebuffer)
	mux.HandleFunc("/api/v1/videos", server.handleListVideos)
	// File Manager endpoints
	mux.HandleFunc("/api/v1/videos/qualities", server.handleVideoQualities)
	mux.HandleFunc("/api/v1/files/info", server.handleFileInfo)
	mux.HandleFunc("/api/v1/files/fm-upload", server.handleFMUpload)
	mux.HandleFunc("/api/v1/files/folder", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			server.handleCreateFolder(w, r)
		case http.MethodDelete:
			server.handleDeleteFolder(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/v1/files/move", server.handleMoveFile)
	mux.HandleFunc("/api/v1/files/copy", server.handleCopyFile)
	mux.HandleFunc("/api/v1/files/upload", server.handleFileUpload)
	mux.HandleFunc("/api/v1/files", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			server.handleListFiles(w, r)
		case http.MethodDelete:
			server.handleDeleteFile(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	// Proxy Upstream Registry
	mux.HandleFunc("/api/v1/proxy/upstreams/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasSuffix(path, "/test") {
			server.handleProxyUpstreamTest(w, r)
		} else {
			server.handleProxyUpstream(w, r)
		}
	})
	mux.HandleFunc("/api/v1/proxy/upstreams", server.handleProxyUpstreams)
	mux.HandleFunc("/api/v1/proxy/fetch", server.handleProxyFetch)
	mux.HandleFunc("/api/v1/proxy/health", server.handleProxyHealth)
	// Stream Cacher
	mux.HandleFunc("/api/v1/cache", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		switch r.Method {
		case http.MethodPost:
			server.handleStartCache(w, r)
		case http.MethodGet:
			server.handleListCache(w, r)
		case http.MethodDelete:
			server.handleDeleteCache(w, r)
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	// YouTube Shorts feed
	mux.HandleFunc("/api/v1/videos/resolve-stream", server.handleResolveStream)
	mux.HandleFunc("/api/v1/videos/shorts", server.handleYTShortsFeed)
	mux.HandleFunc("/api/v1/youtube/cookies", server.handleYTCookies)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"video-service"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Video service starting on %s", addr)

	// Forward proxy listener — separate port, bypasses Kong.
	// Clients point their browser/app HTTP proxy settings here (e.g. for
	// watching YouTube from RU with their own account). Traffic is routed
	// through the upstream registry (socks5/http_proxy chains → non-RU egress).
	fpAddr := fmt.Sprintf(":%s", getEnv("FORWARD_PROXY_PORT", "8090"))
	// NOTE: use a bare HandlerFunc, NOT http.ServeMux — ServeMux 301-redirects
	// CONNECT requests (authority-form has an empty URL.Path, so the mux's
	// clean-path redirect fires instead of routing to the handler).
	fpServer := &http.Server{
		Addr:    fpAddr,
		Handler: http.HandlerFunc(server.forwardProxyHandler),
	}
	go func() {
		log.Printf("Forward proxy listening on %s", fpAddr)
		if err := fpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("Forward proxy error: %v", err)
		}
	}()

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Config struct {
	Port        string
	RedisHost   string
	RedisPort   string
	MinioHost   string
	MinioPort   string
	MinioUser   string
	MinioPass   string
	MinioBucket string
	NatsURL     string
	TempDir     string
}

type TranscodeJob struct {
	ID        string    `json:"id"`
	VideoID   string    `json:"video_id"`
	RoomID    string    `json:"room_id,omitempty"`
	InputURL  string    `json:"input_url"`
	Template  string    `json:"template,omitempty"` // hls_adaptive, hls_720p, mp4_720p, mp4_1080p
	Status    string    `json:"status"`             // queued, processing, done, failed, cancelled
	Progress  int       `json:"progress"`           // 0-100
	Cancelled bool      `json:"cancelled,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Error     string    `json:"error,omitempty"`
}

// TranscodeTemplate describes a named transcoding preset.
type TranscodeTemplate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Format      string `json:"format"`     // hls, mp4
	Custom      bool   `json:"custom"`     // true = user-defined (stored in Redis)
	Resolution  string `json:"resolution,omitempty"` // e.g. "1280x720"
	CRF         int    `json:"crf,omitempty"`        // 0=best, 51=worst (libx264)
	Preset      string `json:"preset,omitempty"`     // ultrafast/fast/medium/slow
	VideoBitrate string `json:"video_bitrate,omitempty"` // e.g. "2500k"
}

var builtinTemplates = []TranscodeTemplate{
	{ID: "hls_adaptive", Name: "HLS Adaptive", Description: "3 qualities: 360p / 720p / 1080p HLS (default)", Format: "hls"},
	{ID: "hls_720p",     Name: "HLS 720p",     Description: "Single-variant 720p HLS",                      Format: "hls"},
	{ID: "mp4_480p",     Name: "MP4 480p",      Description: "H.264 480p MP4 — быстро, небольшой размер",    Format: "mp4", Resolution: "854x480",   VideoBitrate: "1000k", Preset: "fast", CRF: 28},
	{ID: "mp4_720p",     Name: "MP4 720p",      Description: "H.264 720p MP4 file",                          Format: "mp4", Resolution: "1280x720",  VideoBitrate: "2500k", Preset: "fast", CRF: 23},
	{ID: "mp4_1080p",    Name: "MP4 1080p",     Description: "H.264 1080p MP4 file",                         Format: "mp4", Resolution: "1920x1080", VideoBitrate: "5000k", Preset: "fast", CRF: 20},
}

// allTemplates merges builtins + user-defined from Redis.
func (s *Server) allTemplates() []TranscodeTemplate {
	templates := make([]TranscodeTemplate, len(builtinTemplates))
	copy(templates, builtinTemplates)
	ctx := context.Background()
	keys, err := s.redis.Keys(ctx, "transcode:template:*").Result()
	if err != nil {
		return templates
	}
	for _, k := range keys {
		data, err := s.redis.Get(ctx, k).Bytes()
		if err != nil {
			continue
		}
		var t TranscodeTemplate
		if json.Unmarshal(data, &t) == nil && t.Custom {
			templates = append(templates, t)
		}
	}
	return templates
}

func isYouTubeURL(u string) bool {
	return strings.Contains(u, "youtube.com/") || strings.Contains(u, "youtu.be/")
}

// safeScaleFilter converts "WxH" resolution to a safe ffmpeg -vf scale filter that:
// - uses ":" separator (not "x") as required by the scale filter
// - pads to exact dimensions (letterbox) so libx264 always gets even-dimension input
// - avoids exit 254 from odd-pixel rounding on downscale
func safeScaleFilter(resolution string) string {
	parts := strings.SplitN(resolution, "x", 2)
	if len(parts) != 2 {
		return "scale=" + resolution
	}
	w, h := parts[0], parts[1]
	// scale to fit within WxH keeping aspect ratio, then pad to exact WxH, ensure even dims
	return fmt.Sprintf(
		"scale=%s:%s:force_original_aspect_ratio=decrease,pad=%s:%s:(ow-iw)/2:(oh-ih)/2,"+
			"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
		w, h, w, h,
	)
}

func isBuiltinTemplate(id string) bool {
	for _, t := range builtinTemplates {
		if t.ID == id {
			return true
		}
	}
	return false
}

var (
	reDuration = regexp.MustCompile(`Duration: (\d+):(\d+):(\d+)\.(\d+)`)
	reProgress = regexp.MustCompile(`time=(\d+):(\d+):(\d+)\.(\d+)`)
)

// nvencAvailable is set once at startup; true when ffmpeg has h264_nvenc encoder.
var nvencAvailable bool

func detectNVENC() bool {
	out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "h264_nvenc")
}

// videoEncoder returns the best available video encoder (NVENC > libx264).
func videoEncoder() string {
	if nvencAvailable {
		return "h264_nvenc"
	}
	return "libx264"
}

// nvencPreset maps a generic preset name to the equivalent NVENC param.
func encoderPreset() string {
	if nvencAvailable {
		return "llhq"
	}
	return "fast"
}

func parseHMS(h, m, s, cs string) float64 {
	hi, _ := strconv.Atoi(h)
	mi, _ := strconv.Atoi(m)
	si, _ := strconv.Atoi(s)
	ci, _ := strconv.Atoi(cs)
	return float64(hi)*3600 + float64(mi)*60 + float64(si) + float64(ci)/100
}

var (
	jobsProcessed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "transcoder_jobs_processed_total",
		Help: "Total transcode jobs processed",
	})
	jobsFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "transcoder_jobs_failed_total",
		Help: "Total transcode jobs failed",
	})
	activeJobs = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "transcoder_active_jobs",
		Help: "Currently processing jobs",
	})
)

type Server struct {
	config      *Config
	redis       *redis.Client
	minio       *minio.Client
	nats        *nats.Conn
	cancelFuncs sync.Map // jobID → context.CancelFunc
}

func NewServer(cfg *Config) *Server {
	return &Server{config: cfg}
}

func (s *Server) Initialize() error {
	// Connect to Redis
	s.redis = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:%s", s.config.RedisHost, s.config.RedisPort),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis connection failed: %w", err)
	}
	log.Println("Connected to Redis")

	// Connect to MinIO
	mc, err := minio.New(fmt.Sprintf("%s:%s", s.config.MinioHost, s.config.MinioPort), &minio.Options{
		Creds:  credentials.NewStaticV4(s.config.MinioUser, s.config.MinioPass, ""),
		Secure: false,
	})
	if err != nil {
		return fmt.Errorf("minio client failed: %w", err)
	}
	s.minio = mc

	// Ensure bucket exists
	ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	exists, err := mc.BucketExists(ctx2, s.config.MinioBucket)
	if err != nil {
		return fmt.Errorf("minio bucket check failed: %w", err)
	}
	if !exists {
		if err := mc.MakeBucket(ctx2, s.config.MinioBucket, minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("minio bucket create failed: %w", err)
		}
	}
	log.Println("Connected to MinIO")

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

	// Subscribe to transcode requests from NATS
	_, err = nc.Subscribe("transcode.request", s.handleTranscodeRequest)
	if err != nil {
		return fmt.Errorf("nats subscription failed: %w", err)
	}

	// Ensure temp dir exists
	if err := os.MkdirAll(s.config.TempDir, 0755); err != nil {
		return fmt.Errorf("temp dir create failed: %w", err)
	}

	// Detect NVENC hardware encoder availability
	nvencAvailable = detectNVENC()
	if nvencAvailable {
		log.Println("NVENC hardware encoder detected — using h264_nvenc")
	} else {
		log.Println("NVENC not available — using libx264 (software)")
	}

	// Recover stuck jobs from previous run (status=processing → queued)
	s.recoverStuckJobs()

	// Start Redis queue worker
	go s.processQueue()

	return nil
}

// handleTranscodeRequest handles NATS transcode requests
func (s *Server) handleTranscodeRequest(msg *nats.Msg) {
	var req struct {
		VideoID  string `json:"video_id"`
		InputURL string `json:"input_url"`
		RoomID   string `json:"room_id,omitempty"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		log.Printf("Invalid transcode request: %v", err)
		return
	}

	job := TranscodeJob{
		ID:        uuid.New().String(),
		VideoID:   req.VideoID,
		RoomID:    req.RoomID,
		InputURL:  req.InputURL,
		Status:    "queued",
		CreatedAt: time.Now(),
	}

	data, _ := json.Marshal(job)
	ctx := context.Background()
	s.redis.RPush(ctx, "transcode:queue", data)
	s.redis.Set(ctx, fmt.Sprintf("transcode:job:%s", job.ID), data, 24*time.Hour)

	log.Printf("Queued transcode job %s for video %s", job.ID, job.VideoID)
}

// recoverStuckJobs resets any jobs left in "processing" state from a previous
// run back to "queued" and re-enqueues them so they are not lost forever.
func (s *Server) recoverStuckJobs() {
	ctx := context.Background()
	var cursor uint64
	recovered := 0
	for {
		keys, next, err := s.redis.Scan(ctx, cursor, "transcode:job:*", 100).Result()
		if err != nil {
			break
		}
		for _, key := range keys {
			data, err := s.redis.Get(ctx, key).Bytes()
			if err != nil {
				continue
			}
			var job TranscodeJob
			if json.Unmarshal(data, &job) != nil {
				continue
			}
			if job.Status == "processing" {
				job.Status = "queued"
				job.Progress = 0
				updated, _ := json.Marshal(job)
				s.redis.Set(ctx, key, updated, 24*time.Hour)
				s.redis.RPush(ctx, "transcode:queue", updated)
				recovered++
				log.Printf("Recovered stuck job %s (video %s)", job.ID, job.VideoID)
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	if recovered > 0 {
		log.Printf("Recovered %d stuck job(s)", recovered)
	}
}

// processQueue continuously pops jobs from Redis queue and processes them
func (s *Server) processQueue() {
	log.Println("Transcoder queue worker started")
	for {
		ctx := context.Background()
		result, err := s.redis.BLPop(ctx, 5*time.Second, "transcode:queue").Result()
		if err != nil {
			if err != redis.Nil {
				log.Printf("Queue pop error: %v", err)
			}
			continue
		}
		if len(result) < 2 {
			continue
		}

		var job TranscodeJob
		if err := json.Unmarshal([]byte(result[1]), &job); err != nil {
			log.Printf("Invalid job data: %v", err)
			continue
		}

		activeJobs.Inc()
		s.processJob(&job)
		activeJobs.Dec()
	}
}

// processJob transcodes a video to HLS with multiple quality variants
func (s *Server) processJob(job *TranscodeJob) {
	log.Printf("Processing job %s: %s", job.ID, job.InputURL)

	if isYouTubeURL(job.InputURL) {
		s.failJob(job, "YouTube URL нельзя транскодировать напрямую — ffmpeg не может открыть youtube.com. Скачайте видео отдельно и загрузите файл.")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancelFuncs.Store(job.ID, cancel)
	defer func() {
		cancel()
		s.cancelFuncs.Delete(job.ID)
	}()

	// Update status
	s.updateJobStatus(job.ID, "processing", "")

	// Create temp directory for this job
	jobDir := filepath.Join(s.config.TempDir, job.ID)
	if err := os.MkdirAll(jobDir, 0755); err != nil {
		s.failJob(job, fmt.Sprintf("mkdir failed: %v", err))
		return
	}
	defer os.RemoveAll(jobDir)

	// Select variants based on template
	type variant struct{ name, resolution, bitrate string }
	var variants []variant
	switch job.Template {
	case "hls_720p":
		variants = []variant{{"720p", "1280x720", "2500k"}}
	case "mp4_480p":
		s.processMP4Job(job, jobDir, "854x480", "1000k")
		return
	case "mp4_720p":
		s.processMP4Job(job, jobDir, "1280x720", "2500k")
		return
	case "mp4_1080p":
		s.processMP4Job(job, jobDir, "1920x1080", "5000k")
		return
	default: // hls_adaptive, empty, or custom mp4 template
		// Check for user-defined custom template stored in Redis
		if job.Template != "" && !isBuiltinTemplate(job.Template) {
			ctx2 := context.Background()
			data, err := s.redis.Get(ctx2, "transcode:template:"+job.Template).Bytes()
			if err == nil {
				var tmpl TranscodeTemplate
				if json.Unmarshal(data, &tmpl) == nil && tmpl.Format == "mp4" && tmpl.Resolution != "" {
					bitrate := tmpl.VideoBitrate
					if bitrate == "" {
						bitrate = "2500k"
					}
					s.processMP4Job(job, jobDir, tmpl.Resolution, bitrate)
					return
				}
			}
		}
		// Default: hls_adaptive
		variants = []variant{
			{"360p", "640x360", "800k"},
			{"720p", "1280x720", "2500k"},
			{"1080p", "1920x1080", "5000k"},
		}
	}

	var masterLines []string
	masterLines = append(masterLines, "#EXTM3U", "#EXT-X-VERSION:3")

	for vi, v := range variants {
		outDir := filepath.Join(jobDir, v.name)
		if err := os.MkdirAll(outDir, 0755); err != nil {
			s.failJob(job, fmt.Sprintf("variant dir failed: %v", err))
			return
		}

		indexFile := filepath.Join(outDir, "index.m3u8")
		segmentPattern := filepath.Join(outDir, "seg%03d.ts")

		args := []string{
			"-i", job.InputURL,
			"-vf", safeScaleFilter(v.resolution),
			"-c:v", videoEncoder(), "-b:v", v.bitrate, "-preset", encoderPreset(),
			"-c:a", "aac", "-b:a", "128k",
			"-hls_time", "6",
			"-hls_playlist_type", "vod",
			"-hls_segment_filename", segmentPattern,
			"-f", "hls",
			indexFile,
		}

		cmd := exec.CommandContext(ctx, "ffmpeg", args...)
		cmd.Stdout = os.Stdout
		stderrPipe, pipeErr := cmd.StderrPipe()
		if pipeErr != nil {
			cmd.Stderr = os.Stderr
		}

		if err := cmd.Start(); err != nil {
			if ctx.Err() != nil {
				s.cancelJob(job)
				return
			}
			s.failJob(job, fmt.Sprintf("ffmpeg %s start failed: %v", v.name, err))
			return
		}

		var stderrBuf strings.Builder
		if stderrPipe != nil {
			var duration float64
			lastPct := -1
			scanner := bufio.NewScanner(stderrPipe)
			for scanner.Scan() {
				line := scanner.Text()
				stderrBuf.WriteString(line + "\n")
				if duration == 0 {
					if m := reDuration.FindStringSubmatch(line); m != nil {
						duration = parseHMS(m[1], m[2], m[3], m[4])
					}
				}
				if duration > 0 {
					if m := reProgress.FindStringSubmatch(line); m != nil {
						cur := parseHMS(m[1], m[2], m[3], m[4])
						variantPct := int(cur / duration * 100)
						overall := (vi*100 + variantPct) / len(variants)
						if overall != lastPct {
							lastPct = overall
							s.setJobProgress(job, overall)
						}
					}
				}
			}
		}

		if err := cmd.Wait(); err != nil {
			if ctx.Err() != nil {
				s.cancelJob(job)
				return
			}
			s.failJob(job, fmt.Sprintf("ffmpeg %s failed: %v — %s", v.name, err, stderrBuf.String()))
			return
		}

		// Upload segments to MinIO
		prefix := fmt.Sprintf("hls/%s/%s/", job.VideoID, v.name)
		if err := s.uploadDirectory(outDir, prefix); err != nil {
			s.failJob(job, fmt.Sprintf("upload %s failed: %v", v.name, err))
			return
		}

		bw := strings.TrimSuffix(v.bitrate, "k")
		masterLines = append(masterLines,
			fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%s000,RESOLUTION=%s", bw, v.resolution),
			fmt.Sprintf("%s/index.m3u8", v.name),
		)

		log.Printf("Job %s: %s variant complete", job.ID, v.name)
	}

	// Create and upload master playlist
	masterContent := strings.Join(masterLines, "\n") + "\n"
	masterPath := filepath.Join(jobDir, "master.m3u8")
	if err := os.WriteFile(masterPath, []byte(masterContent), 0644); err != nil {
		s.failJob(job, fmt.Sprintf("master playlist write failed: %v", err))
		return
	}

	masterKey := fmt.Sprintf("hls/%s/master.m3u8", job.VideoID)
	_, err := s.minio.FPutObject(ctx, s.config.MinioBucket, masterKey, masterPath, minio.PutObjectOptions{
		ContentType: "application/vnd.apple.mpegurl",
	})
	if err != nil {
		s.failJob(job, fmt.Sprintf("master playlist upload failed: %v", err))
		return
	}

	// Mark job complete
	s.updateJobStatus(job.ID, "done", "")
	jobsProcessed.Inc()

	s.setJobProgress(job, 100)

	streamURL := fmt.Sprintf("/api/v1/videos/stream/hls/%s/master.m3u8", job.VideoID)

	// Publish completion event to NATS
	completionData, _ := json.Marshal(map[string]any{
		"job_id":     job.ID,
		"video_id":   job.VideoID,
		"room_id":    job.RoomID,
		"master_url": fmt.Sprintf("/videos/hls/%s/master.m3u8", job.VideoID),
		"stream_url": streamURL,
		"status":     "done",
	})
	s.nats.Publish("transcode.completed", completionData)
	if job.RoomID != "" {
		evt, _ := json.Marshal(map[string]any{
			"type": "transcode_completed",
			"payload": map[string]any{
				"job_id":     job.ID,
				"video_id":   job.VideoID,
				"stream_url": streamURL,
				"status":     "done",
			},
		})
		s.nats.Publish(fmt.Sprintf("room.%s.broadcast", job.RoomID), evt)
	}

	log.Printf("Job %s completed for video %s", job.ID, job.VideoID)
}

// processMP4Job transcodes a single MP4 file at the given resolution/bitrate.
func (s *Server) processMP4Job(job *TranscodeJob, jobDir, resolution, bitrate string) {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelFuncs.Store(job.ID, cancel)
	defer func() {
		cancel()
		s.cancelFuncs.Delete(job.ID)
	}()

	outFile := filepath.Join(jobDir, "output.mp4")
	args := []string{
		"-i", job.InputURL,
		"-vf", safeScaleFilter(resolution),
		"-c:v", videoEncoder(), "-b:v", bitrate, "-preset", encoderPreset(),
		"-c:a", "aac", "-b:a", "128k",
		"-movflags", "+faststart",
		"-y", outFile,
	}

	s.setJobProgress(job, 5)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		s.failJob(job, fmt.Sprintf("ffmpeg pipe: %v", err))
		return
	}
	if err := cmd.Start(); err != nil {
		if ctx.Err() != nil {
			s.cancelJob(job)
			return
		}
		s.failJob(job, fmt.Sprintf("ffmpeg start: %v", err))
		return
	}
	var totalSec float64
	var stderrBuf strings.Builder
	scanner := bufio.NewScanner(stderrPipe)
	for scanner.Scan() {
		line := scanner.Text()
		stderrBuf.WriteString(line + "\n")
		if totalSec == 0 {
			if m := reDuration.FindStringSubmatch(line); len(m) == 5 {
				totalSec = parseHMS(m[1], m[2], m[3], m[4])
			}
		}
		if totalSec > 0 {
			if m := reProgress.FindStringSubmatch(line); len(m) == 5 {
				cur := parseHMS(m[1], m[2], m[3], m[4])
				pct := int((cur / totalSec) * 90)
				s.setJobProgress(job, 5+pct)
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			s.cancelJob(job)
			return
		}
		s.failJob(job, fmt.Sprintf("ffmpeg: %v — %s", err, stderrBuf.String()))
		return
	}

	minioKey := fmt.Sprintf("videos/%s/output.mp4", job.VideoID)
	if _, err := s.minio.FPutObject(context.Background(), s.config.MinioBucket, minioKey, outFile, minio.PutObjectOptions{ContentType: "video/mp4"}); err != nil {
		s.failJob(job, fmt.Sprintf("minio upload: %v", err))
		return
	}

	s.setJobProgress(job, 100)
	outputURL := fmt.Sprintf("http://%s:%s/%s/%s", s.config.MinioHost, s.config.MinioPort, s.config.MinioBucket, minioKey)
	s.updateJobStatus(job.ID, "done", "")

	if job.RoomID != "" && s.nats != nil {
		payload, _ := json.Marshal(map[string]interface{}{
			"type": "room.broadcast",
			"payload": map[string]interface{}{
				"type": "transcode_completed",
				"payload": map[string]interface{}{
					"job_id": job.ID, "status": "done", "output_url": outputURL,
				},
			},
			"room_id": job.RoomID,
		})
		s.nats.Publish(fmt.Sprintf("room.%s.broadcast", job.RoomID), payload)
	}
	log.Printf("MP4 job %s completed: %s", job.ID, outputURL)
}

func (s *Server) uploadDirectory(localDir, minioPrefix string) error {
	entries, err := os.ReadDir(localDir)
	if err != nil {
		return err
	}

	ctx := context.Background()
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		localPath := filepath.Join(localDir, entry.Name())
		objectKey := minioPrefix + entry.Name()

		contentType := "application/octet-stream"
		if strings.HasSuffix(entry.Name(), ".m3u8") {
			contentType = "application/vnd.apple.mpegurl"
		} else if strings.HasSuffix(entry.Name(), ".ts") {
			contentType = "video/mp2t"
		}

		_, err := s.minio.FPutObject(ctx, s.config.MinioBucket, objectKey, localPath, minio.PutObjectOptions{
			ContentType: contentType,
		})
		if err != nil {
			return fmt.Errorf("upload %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func (s *Server) updateJobStatus(jobID, status, errMsg string) {
	ctx := context.Background()
	key := fmt.Sprintf("transcode:job:%s", jobID)
	data, err := s.redis.Get(ctx, key).Bytes()
	if err != nil {
		return
	}
	var job TranscodeJob
	if err := json.Unmarshal(data, &job); err != nil {
		return
	}
	job.Status = status
	job.Error = errMsg
	updated, _ := json.Marshal(job)
	s.redis.Set(ctx, key, updated, 24*time.Hour)
}

func (s *Server) setJobProgress(job *TranscodeJob, pct int) {
	ctx := context.Background()
	key := fmt.Sprintf("transcode:job:%s", job.ID)
	data, err := s.redis.Get(ctx, key).Bytes()
	if err != nil {
		return
	}
	var j TranscodeJob
	if json.Unmarshal(data, &j) != nil {
		return
	}
	j.Progress = pct
	updated, _ := json.Marshal(j)
	s.redis.Set(ctx, key, updated, 24*time.Hour)
	if s.nats != nil && j.RoomID != "" {
		evt, _ := json.Marshal(map[string]any{
			"type": "transcode_progress",
			"payload": map[string]any{
				"job_id":   job.ID,
				"video_id": job.VideoID,
				"progress": pct,
			},
		})
		s.nats.Publish(fmt.Sprintf("room.%s.broadcast", j.RoomID), evt)
	}
}

func (s *Server) cancelJob(job *TranscodeJob) {
	log.Printf("Job %s cancelled", job.ID)
	ctx := context.Background()
	key := fmt.Sprintf("transcode:job:%s", job.ID)
	data, err := s.redis.Get(ctx, key).Bytes()
	if err != nil {
		return
	}
	var j TranscodeJob
	if json.Unmarshal(data, &j) != nil {
		return
	}
	j.Status = "cancelled"
	j.Cancelled = true
	updated, _ := json.Marshal(j)
	s.redis.Set(ctx, key, updated, 24*time.Hour)
}

// POST /api/v1/transcode/{jobId}/cancel
func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/transcode/"), "/")
	if len(parts) < 1 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid_path", "Job ID required")
		return
	}
	jobID := parts[0]

	if fn, ok := s.cancelFuncs.Load(jobID); ok {
		fn.(context.CancelFunc)()
		writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling", "job_id": jobID})
		return
	}

	// Job not actively processing — mark cancelled in Redis if queued
	ctx := context.Background()
	key := fmt.Sprintf("transcode:job:%s", jobID)
	data, err := s.redis.Get(ctx, key).Bytes()
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Job not found")
		return
	}
	var job TranscodeJob
	if json.Unmarshal(data, &job) != nil {
		writeError(w, http.StatusInternalServerError, "parse_error", "Failed to parse job")
		return
	}
	if job.Status == "done" || job.Status == "failed" || job.Status == "cancelled" {
		writeError(w, http.StatusConflict, "already_finished", "Job already in terminal state: "+job.Status)
		return
	}
	job.Status = "cancelled"
	job.Cancelled = true
	updated, _ := json.Marshal(job)
	s.redis.Set(ctx, key, updated, 24*time.Hour)
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled", "job_id": jobID})
}

func (s *Server) failJob(job *TranscodeJob, msg string) {
	log.Printf("Job %s failed: %s", job.ID, msg)
	s.updateJobStatus(job.ID, "failed", msg)
	jobsFailed.Inc()
	if s.nats != nil && job.RoomID != "" {
		evt, _ := json.Marshal(map[string]any{
			"type": "transcode_completed",
			"payload": map[string]any{
				"job_id":   job.ID,
				"video_id": job.VideoID,
				"status":   "failed",
				"error":    msg,
			},
		})
		s.nats.Publish(fmt.Sprintf("room.%s.broadcast", job.RoomID), evt)
	}
}

// /api/v1/transcode/:jobId and /api/v1/transcode/:jobId/cancel
func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/transcode/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid_path", "Job ID required")
		return
	}

	// Route POST /{jobId}/cancel to cancel handler
	if len(parts) == 2 && parts[1] == "cancel" {
		s.handleCancelJob(w, r)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jobID := parts[0]

	ctx := context.Background()
	data, err := s.redis.Get(ctx, fmt.Sprintf("transcode:job:%s", jobID)).Bytes()
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Job not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// POST /api/v1/transcode — submit a job
// handleExtractSubtitles extracts a subtitle track from a video file and stores it in MinIO.
// POST /api/v1/transcode/extract-subtitles  body: { input_url, stream_index?, format? }
func (s *Server) handleExtractSubtitles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		InputURL    string `json:"input_url"`
		StreamIndex int    `json:"stream_index"` // 0-based subtitle stream index
		Format      string `json:"format"`       // srt | ass | vtt (default: srt)
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}
	if req.InputURL == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "input_url required")
		return
	}
	if req.Format == "" {
		req.Format = "srt"
	}
	switch req.Format {
	case "srt", "ass", "vtt":
	default:
		writeError(w, http.StatusBadRequest, "invalid_format", "format must be srt, ass, or vtt")
		return
	}

	id := uuid.New().String()
	outFile := filepath.Join(s.config.TempDir, id+"."+req.Format)
	defer os.Remove(outFile)

	if err := os.MkdirAll(s.config.TempDir, 0755); err != nil {
		writeError(w, http.StatusInternalServerError, "mkdir_failed", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()

	streamMap := fmt.Sprintf("0:s:%d", req.StreamIndex)
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", req.InputURL,
		"-map", streamMap,
		"-y", outFile,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("Subtitle extraction failed: %v\n%s", err, output)
		writeError(w, http.StatusUnprocessableEntity, "extraction_failed", "No subtitle stream at index "+strconv.Itoa(req.StreamIndex)+". Check that the video contains subtitle tracks.")
		return
	}

	f, err := os.Open(outFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "file_open_failed", err.Error())
		return
	}
	defer f.Close()

	fi, _ := f.Stat()
	objectName := fmt.Sprintf("subtitles/%s.%s", id, req.Format)
	contentType := "text/plain"
	if req.Format == "vtt" {
		contentType = "text/vtt"
	}

	_, err = s.minio.PutObject(ctx, s.config.MinioBucket, objectName, f, fi.Size(),
		minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "upload_failed", err.Error())
		return
	}

	minioURL := fmt.Sprintf("http://%s:%s/%s/%s", s.config.MinioHost, s.config.MinioPort, s.config.MinioBucket, objectName)
	writeJSON(w, http.StatusOK, map[string]string{
		"url":      minioURL,
		"filename": id + "." + req.Format,
		"format":   req.Format,
	})
}

func (s *Server) handleTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.allTemplates())
	case http.MethodPost:
		s.handleCreateTemplate(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

var validResolutions = map[string]bool{
	"426x240": true, "640x360": true, "854x480": true,
	"1280x720": true, "1920x1080": true, "2560x1440": true, "3840x2160": true,
}
var validPresets = map[string]bool{
	"ultrafast": true, "superfast": true, "veryfast": true,
	"faster": true, "fast": true, "medium": true, "slow": true, "slower": true,
}

// POST /api/v1/transcode/templates — create a user-defined template (stored in Redis, TTL 30 days)
func (s *Server) handleCreateTemplate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		Format       string `json:"format"`        // mp4 only for custom
		Resolution   string `json:"resolution"`    // e.g. "1280x720"
		VideoBitrate string `json:"video_bitrate"` // e.g. "2500k"
		CRF          int    `json:"crf"`           // 0-51
		Preset       string `json:"preset"`        // ultrafast..slow
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "Invalid JSON")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "missing_name", "name is required")
		return
	}
	if req.Format != "mp4" {
		writeError(w, http.StatusBadRequest, "invalid_format", "custom templates only support format=mp4")
		return
	}
	if req.Resolution != "" && !validResolutions[req.Resolution] {
		writeError(w, http.StatusBadRequest, "invalid_resolution", "unsupported resolution")
		return
	}
	if req.Preset != "" && !validPresets[req.Preset] {
		writeError(w, http.StatusBadRequest, "invalid_preset", "unsupported preset")
		return
	}
	if req.CRF < 0 || req.CRF > 51 {
		writeError(w, http.StatusBadRequest, "invalid_crf", "crf must be 0-51")
		return
	}
	if req.Resolution == "" {
		req.Resolution = "1280x720"
	}
	if req.VideoBitrate == "" {
		req.VideoBitrate = "2500k"
	}
	if req.Preset == "" {
		req.Preset = "fast"
	}
	if req.CRF == 0 {
		req.CRF = 23
	}

	tmpl := TranscodeTemplate{
		ID:           uuid.New().String(),
		Name:         req.Name,
		Description:  req.Description,
		Format:       "mp4",
		Custom:       true,
		Resolution:   req.Resolution,
		VideoBitrate: req.VideoBitrate,
		CRF:          req.CRF,
		Preset:       req.Preset,
	}
	data, _ := json.Marshal(tmpl)
	ctx := context.Background()
	s.redis.Set(ctx, "transcode:template:"+tmpl.ID, data, 30*24*time.Hour)
	writeJSON(w, http.StatusCreated, tmpl)
}

// DELETE /api/v1/transcode/templates/{id}
func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/transcode/templates/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "template id required")
		return
	}
	if isBuiltinTemplate(id) {
		writeError(w, http.StatusForbidden, "builtin_template", "cannot delete built-in templates")
		return
	}
	ctx := context.Background()
	res := s.redis.Del(ctx, "transcode:template:"+id)
	if res.Val() == 0 {
		writeError(w, http.StatusNotFound, "not_found", "template not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": id})
}

// POST /api/v1/transcode/quick — one-click transcode with sane defaults (mp4_720p or mp4_1080p if NVENC)
func (s *Server) handleQuickJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		VideoID  string `json:"video_id"`
		InputURL string `json:"input_url"`
		RoomID   string `json:"room_id,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}
	if req.VideoID == "" || req.InputURL == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "video_id and input_url required")
		return
	}
	if isYouTubeURL(req.InputURL) {
		writeError(w, http.StatusBadRequest, "youtube_not_supported", "YouTube URL нельзя транскодировать напрямую — ffmpeg не может открыть youtube.com. Скачайте видео отдельно и загрузите файл.")
		return
	}

	// Pick best default: 1080p if NVENC available (hardware-accelerated), 720p otherwise
	template := "mp4_720p"
	if nvencAvailable {
		template = "mp4_1080p"
	}

	job := TranscodeJob{
		ID:        uuid.New().String(),
		VideoID:   req.VideoID,
		RoomID:    req.RoomID,
		InputURL:  req.InputURL,
		Template:  template,
		Status:    "queued",
		CreatedAt: time.Now(),
	}

	data, _ := json.Marshal(job)
	ctx := context.Background()
	s.redis.RPush(ctx, "transcode:queue", data)
	s.redis.Set(ctx, fmt.Sprintf("transcode:job:%s", job.ID), data, 24*time.Hour)

	writeJSON(w, http.StatusCreated, job)
}

func (s *Server) handleSubmitJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		VideoID  string `json:"video_id"`
		InputURL string `json:"input_url"`
		RoomID   string `json:"room_id,omitempty"`
		Template string `json:"template,omitempty"` // hls_adaptive, hls_720p, mp4_720p, mp4_1080p
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}
	if req.VideoID == "" || req.InputURL == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "video_id and input_url required")
		return
	}
	if isYouTubeURL(req.InputURL) {
		writeError(w, http.StatusBadRequest, "youtube_not_supported", "YouTube URL нельзя транскодировать напрямую — ffmpeg не может открыть youtube.com. Скачайте видео отдельно и загрузите файл.")
		return
	}

	// Validate template if provided
	if req.Template != "" {
		valid := false
		for _, t := range s.allTemplates() {
			if t.ID == req.Template {
				valid = true
				break
			}
		}
		if !valid {
			writeError(w, http.StatusBadRequest, "invalid_template", "Unknown template; GET /api/v1/transcode/templates for list")
			return
		}
	}

	job := TranscodeJob{
		ID:        uuid.New().String(),
		VideoID:   req.VideoID,
		RoomID:    req.RoomID,
		InputURL:  req.InputURL,
		Template:  req.Template,
		Status:    "queued",
		CreatedAt: time.Now(),
	}

	data, _ := json.Marshal(job)
	ctx := context.Background()
	s.redis.RPush(ctx, "transcode:queue", data)
	s.redis.Set(ctx, fmt.Sprintf("transcode:job:%s", job.ID), data, 24*time.Hour)

	writeJSON(w, http.StatusCreated, job)
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
		RedisHost:   getEnv("REDIS_HOST", "localhost"),
		RedisPort:   getEnv("REDIS_PORT", "6379"),
		MinioHost:   getEnv("MINIO_HOST", "localhost"),
		MinioPort:   getEnv("MINIO_PORT", "9000"),
		MinioUser:   getEnv("MINIO_ROOT_USER", "watchsync"),
		MinioPass:   getEnv("MINIO_ROOT_PASSWORD", "watchsync123"),
		MinioBucket: getEnv("MINIO_BUCKET", "videos"),
		NatsURL:     getEnv("NATS_URL", "nats://localhost:4222"),
		TempDir:     getEnv("TEMP_DIR", "/tmp/transcoder"),
	}

	server := NewServer(config)
	if err := server.Initialize(); err != nil {
		log.Fatalf("Failed to initialize: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/transcode", server.handleSubmitJob)
	mux.HandleFunc("/api/v1/transcode/templates/", server.handleDeleteTemplate)
	mux.HandleFunc("/api/v1/transcode/templates", server.handleTemplates)
	mux.HandleFunc("/api/v1/transcode/quick", server.handleQuickJob)
	mux.HandleFunc("/api/v1/transcode/extract-subtitles", server.handleExtractSubtitles)
	mux.HandleFunc("/api/v1/transcode/", server.handleGetJob)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","service":"transcoder"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("Transcoder service starting on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

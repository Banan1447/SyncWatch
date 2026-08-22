-- =============================================================================
-- WatchSync Platform — PostgreSQL Init: Video Queue
-- =============================================================================

CREATE TABLE IF NOT EXISTS video_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    video_source VARCHAR(50) NOT NULL,
    video_url TEXT NOT NULL,
    video_metadata JSONB DEFAULT '{}',
    position INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_queue_room ON video_queue(room_id, position);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_queue(status);

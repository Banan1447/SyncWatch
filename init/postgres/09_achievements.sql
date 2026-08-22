-- =============================================================================
-- WatchSync Platform — PostgreSQL Init: Achievements
-- =============================================================================
-- Stores which achievements a user has unlocked. Achievement definitions and
-- their unlock conditions live in services/user/main.go (achievement engine).
-- Unlock is idempotent: (user_id, achievement_id) is the primary key, so an
-- INSERT ... ON CONFLICT DO NOTHING only records the first unlock.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id VARCHAR(64) NOT NULL,
    unlocked_at    TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);

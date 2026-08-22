-- =============================================================================
-- WatchSync Platform — PostgreSQL Init: Permission Groups
-- =============================================================================
-- Permission model: named groups with a JSONB map of boolean capabilities.
-- Every user resolves to exactly one effective permission set:
--   1. Explicit assignment (users.permission_group_id)
--   2. Anonymous users (preferences->>'is_anonymous' = 'true') → 'anonymous'
--   3. Everyone else → 'registered' (all permissions enabled)
--
-- Global groups (anonymous / registered) cannot be deleted, only edited.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS permission_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(64) UNIQUE NOT NULL,
    is_global BOOLEAN DEFAULT FALSE,
    is_anonymous_default BOOLEAN DEFAULT FALSE,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permission_groups_name ON permission_groups(name);

-- Assignable group for users (NULL = auto-resolve via anonymous/registered).
-- Kept here (not in 01_users.sql) so the whole permissions feature lives in one file.
ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_group_id UUID REFERENCES permission_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_permission_group ON users(permission_group_id);

-- ── Seed global groups ───────────────────────────────────────────────────────
-- 'anonymous': anonymous/privacy-first users get a reduced capability set.
-- 'registered': registered users without an explicit group get everything.
-- Fixed UUIDs keep the groups stable across idempotent re-runs.
INSERT INTO permission_groups (id, name, is_global, is_anonymous_default, permissions)
VALUES
    (
        '00000000-0000-0000-0000-000000000001',
        'anonymous',
        TRUE,
        TRUE,
        '{
            "can_join_room": true,
            "can_chat": true,
            "can_add_to_queue": false,
            "can_use_mic": false,
            "can_stream": false,
            "can_upload_file": false,
            "can_create_room": false,
            "can_use_proxy": false,
            "can_invite": false
        }'::jsonb
    ),
    (
        '00000000-0000-0000-0000-000000000002',
        'registered',
        TRUE,
        FALSE,
        '{
            "can_join_room": true,
            "can_chat": true,
            "can_add_to_queue": true,
            "can_use_mic": true,
            "can_stream": true,
            "can_upload_file": true,
            "can_create_room": true,
            "can_use_proxy": true,
            "can_invite": true
        }'::jsonb
    )
ON CONFLICT (name) DO NOTHING;

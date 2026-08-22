-- =============================================================================
-- WatchSync Platform — ScyllaDB Init: Chat
-- =============================================================================

CREATE KEYSPACE IF NOT EXISTS chat
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    AND durable_writes = true;

USE chat;

CREATE TABLE IF NOT EXISTS chat_messages (
    room_id UUID,
    bucket TIMESTAMP,
    message_id TIMEUUID,
    user_id UUID,
    username TEXT,
    avatar_url TEXT,
    content TEXT,
    message_type TEXT,
    metadata MAP<TEXT, TEXT>,
    PRIMARY KEY ((room_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 2592000;

CREATE INDEX IF NOT EXISTS ON chat_messages(user_id);

CREATE TABLE IF NOT EXISTS chat_read_receipts (
    room_id UUID,
    user_id UUID,
    last_read_message_id TIMEUUID,
    last_read_at TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
);

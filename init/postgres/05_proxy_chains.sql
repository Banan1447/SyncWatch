-- Add chain_ids to proxy_upstreams: ordered array of upstream IDs to tunnel through
-- before reaching the final upstream/target. e.g. [socks5_id] → flaresolverr → target.

ALTER TABLE proxy_upstreams
    ADD COLUMN IF NOT EXISTS chain_ids JSONB NOT NULL DEFAULT '[]';

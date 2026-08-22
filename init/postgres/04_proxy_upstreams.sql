-- Proxy upstream providers registry
-- Allows routing video requests through different proxy mechanisms

CREATE TABLE IF NOT EXISTS proxy_upstreams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type        VARCHAR(30) NOT NULL CHECK (type IN ('direct', 'http_proxy', 'socks5', 'flaresolverr')),
    endpoint    VARCHAR(500) NOT NULL DEFAULT '',
    auth        JSONB NOT NULL DEFAULT '{}',
    rules       JSONB NOT NULL DEFAULT '[]',
    priority    INTEGER NOT NULL DEFAULT 0,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- URL routing rules: [{url_pattern, action}]
-- action: "use" = route through this upstream, "skip" = skip this upstream for this URL
-- url_pattern: regex matched against full URL

CREATE INDEX IF NOT EXISTS proxy_upstreams_priority_idx ON proxy_upstreams (priority ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS proxy_upstreams_enabled_idx ON proxy_upstreams (enabled);

-- Health status tracked separately (not persisted, in-memory + Redis)
-- INSERT default "direct" upstream so the list is never empty
INSERT INTO proxy_upstreams (name, description, type, endpoint, priority, enabled)
VALUES ('Direct', 'Прямое подключение без прокси', 'direct', '', 0, TRUE)
ON CONFLICT DO NOTHING;

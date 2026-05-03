CREATE TABLE IF NOT EXISTS usage_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,  -- 'log_ingest' | 'relay_event' | 'api_call'
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_user_time ON usage_events(user_id, created_at DESC);
CREATE INDEX idx_usage_type     ON usage_events(user_id, event_type, created_at DESC);
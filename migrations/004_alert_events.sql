CREATE TABLE IF NOT EXISTS alert_events (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id  UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  count    INTEGER NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_alert_events_user ON alert_events(user_id, fired_at DESC);
CREATE INDEX idx_alert_events_rule ON alert_events(rule_id, fired_at DESC);
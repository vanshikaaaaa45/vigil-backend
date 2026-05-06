CREATE TABLE IF NOT EXISTS maintenance_windows (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  monitor_id  UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL DEFAULT 'Scheduled maintenance',
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  repeat_weekly BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_maintenance_monitor ON maintenance_windows(monitor_id);
CREATE INDEX idx_maintenance_active  ON maintenance_windows(user_id, starts_at, ends_at);
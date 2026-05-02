-- ================================================================
-- VIGIL — Complete Database Schema v1
-- Run via: node migrations/run.js
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────────
-- USERS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) UNIQUE NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  plan             VARCHAR(20)  NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team')),
  email_verified   BOOLEAN      NOT NULL DEFAULT FALSE,
  verify_token     VARCHAR(255),
  verify_token_exp TIMESTAMPTZ,
  reset_token      VARCHAR(255),
  reset_token_exp  TIMESTAMPTZ,
  avatar_url       VARCHAR(500),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- REFRESH TOKENS  (httpOnly cookie ↔ DB hash)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- API KEYS  (raw key shown once, only SHA-256 hash stored)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL DEFAULT 'Default Key',
  key_hash    VARCHAR(255) NOT NULL UNIQUE,
  key_prefix  VARCHAR(30)  NOT NULL,
  permissions VARCHAR(20)  NOT NULL DEFAULT 'full' CHECK (permissions IN ('full','readonly')),
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- MONITORS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitors (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  url              VARCHAR(2000) NOT NULL,
  method           VARCHAR(10)  NOT NULL DEFAULT 'GET',
  interval_seconds INTEGER      NOT NULL DEFAULT 60  CHECK (interval_seconds IN (60,300,900,3600)),
  timeout_ms       INTEGER      NOT NULL DEFAULT 5000,
  expected_status  INTEGER      NOT NULL DEFAULT 200,
  status           VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  last_status      VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (last_status IN ('up','down','slow','pending')),
  last_checked_at  TIMESTAMPTZ,
  last_response_ms INTEGER,
  notify_email     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- MONITOR RESULTS  (one row per check, kept 90 days)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitor_results (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  monitor_id    UUID    NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  is_up         BOOLEAN NOT NULL,
  status_code   INTEGER,
  response_ms   INTEGER,
  error_message TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitor_results_monitor_time
  ON monitor_results(monitor_id, checked_at DESC);

-- ────────────────────────────────────────────────────────────────
-- INCIDENTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  monitor_id       UUID        NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  title            VARCHAR(500) NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  duration_seconds INTEGER
);

-- ────────────────────────────────────────────────────────────────
-- LOG ENTRIES  (JSONB meta + full-text search)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS log_entries (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service   VARCHAR(255) NOT NULL,
  level     VARCHAR(20)  NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message   TEXT         NOT NULL,
  meta      JSONB        NOT NULL DEFAULT '{}',
  timestamp TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_log_entries_user_time
  ON log_entries(user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_log_entries_service_level
  ON log_entries(user_id, service, level);

CREATE INDEX IF NOT EXISTS idx_log_entries_fts
  ON log_entries USING GIN(to_tsvector('english', message));

-- ────────────────────────────────────────────────────────────────
-- ALERT RULES  (sliding-window log thresholds)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  service         VARCHAR(255),
  level           VARCHAR(20)  CHECK (level IN ('debug','info','warn','error')),
  threshold       INTEGER      NOT NULL DEFAULT 5,
  window_seconds  INTEGER      NOT NULL DEFAULT 300,
  notify_email    BOOLEAN      NOT NULL DEFAULT TRUE,
  notify_webhook  VARCHAR(500),
  last_triggered  TIMESTAMPTZ,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- RELAY CHANNELS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_channels (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

-- ────────────────────────────────────────────────────────────────
-- RELAY LISTENERS  (fan-out targets)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_listeners (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id  UUID         NOT NULL REFERENCES relay_channels(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL DEFAULT 'service',
  url         VARCHAR(2000) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- RELAY EVENTS  (one row per incoming webhook)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id  UUID         NOT NULL REFERENCES relay_channels(id) ON DELETE CASCADE,
  event_type  VARCHAR(255) NOT NULL,
  payload     JSONB        NOT NULL DEFAULT '{}',
  headers     JSONB        NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relay_events_channel_time
  ON relay_events(channel_id, received_at DESC);

-- ────────────────────────────────────────────────────────────────
-- RELAY DELIVERIES  (one row per listener per event)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_deliveries (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id     UUID    NOT NULL REFERENCES relay_events(id)    ON DELETE CASCADE,
  listener_id  UUID    NOT NULL REFERENCES relay_listeners(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed','retrying')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  error        TEXT,
  delivered_at TIMESTAMPTZ,
  next_retry   TIMESTAMPTZ
);

-- ────────────────────────────────────────────────────────────────
-- NOTIFICATION SETTINGS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_settings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  monitor_alerts    BOOLEAN NOT NULL DEFAULT TRUE,
  log_alert_rules   BOOLEAN NOT NULL DEFAULT TRUE,
  relay_failures    BOOLEAN NOT NULL DEFAULT FALSE,
  weekly_summary    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- updated_at auto-trigger
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_monitors_updated_at
    BEFORE UPDATE ON monitors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_notification_settings_updated_at
    BEFORE UPDATE ON notification_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ================================================================
-- VIGIL — Feature additions v2
-- Run: node migrations/run.js
-- ================================================================

-- Add Slack webhook to notification_settings
ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS slack_webhook_url  VARCHAR(500),
  ADD COLUMN IF NOT EXISTS discord_webhook_url VARCHAR(500);

-- Add public status page slug to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status_page_slug VARCHAR(100) UNIQUE;

-- Add log_retention_days to users (7 for free, 30 for pro)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS log_retention_days INTEGER NOT NULL DEFAULT 7;

-- Add notify_slack to monitors (per-monitor Slack override)
ALTER TABLE monitors
  ADD COLUMN IF NOT EXISTS notify_slack VARCHAR(500);

-- Index for public status page lookup
CREATE INDEX IF NOT EXISTS idx_users_status_slug ON users(status_page_slug);

-- Index for log retention cleanup
CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries(timestamp);
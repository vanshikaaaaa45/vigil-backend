-- Add SLA threshold to monitors
-- If response_ms exceeds sla_ms, monitor is marked 'slow'
ALTER TABLE monitors
  ADD COLUMN IF NOT EXISTS sla_ms INTEGER DEFAULT NULL;
-- NULL = no SLA threshold set (default, no slow alerts)
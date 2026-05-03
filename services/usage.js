const { query } = require('../config/db');

const trackUsage = (userId, eventType, apiKeyId = null, metadata = {}) => {
  // Fire-and-forget — never await, never throws
  query(
    `INSERT INTO usage_events (user_id, event_type, api_key_id, metadata)
     VALUES ($1, $2, $3, $4)`,
    [userId, eventType, apiKeyId, JSON.stringify(metadata)]
  ).catch(() => {});
};

module.exports = { trackUsage };
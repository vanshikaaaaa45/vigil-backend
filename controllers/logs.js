const { query } = require('../config/db');
const { sendAlertRuleFired } = require('../services/email');
const { trackUsage } = require('../services/usage');   // ← Phase 1A

// ── INGEST (SDK calls this) ───────────────────────────────────────
exports.ingest = async (req, res) => {
  try {
    const { service, level, message, meta = {} } = req.body;
    if (!service || !level || !message)
      return res.status(400).json({ error: 'service, level, message required' });

    const LEVELS = ['debug','info','warn','error'];
    if (!LEVELS.includes(level))
      return res.status(400).json({ error: `level must be one of: ${LEVELS.join(', ')}` });

    const { rows } = await query(
      `INSERT INTO log_entries (user_id,service,level,message,meta)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,service,level,message,meta,timestamp`,
      [req.user.id, service, level, message, JSON.stringify(meta)]
    );
    const log = rows[0];

    // ── Track usage (fire-and-forget, never blocks response) ──────
    trackUsage(req.user.id, 'log_ingest', req.apiKeyId || null, { level, service });

    // Push to WebSocket room
    const io = req.app.get('io');
    if (io) io.to(`user:${req.user.id}`).emit('log:new', log);

    // Evaluate alert rules (background)
    checkAlertRules(req.user.id, log).catch(console.error);

    res.status(201).json({ log });
  } catch (err) {
    console.error('ingest:', err);
    res.status(500).json({ error: 'Failed to ingest log' });
  }
};

// ── QUERY LOGS ────────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    const { service, level, search, limit=100, offset=0, from, to } = req.query;
    let conds = ['user_id=$1'], params = [req.user.id], p=2;

    if (service) { conds.push(`service=$${p++}`); params.push(service); }
    if (level)   { conds.push(`level=$${p++}`);   params.push(level);   }
    if (from)    { conds.push(`timestamp>=$${p++}`); params.push(from); }
    if (to)      { conds.push(`timestamp<=$${p++}`); params.push(to);   }
    if (search)  {
      conds.push(`to_tsvector('english',message) @@ plainto_tsquery('english',$${p++})`);
      params.push(search);
    }

    const { rows } = await query(
      `SELECT id,service,level,message,meta,timestamp
       FROM log_entries WHERE ${conds.join(' AND ')}
       ORDER BY timestamp DESC LIMIT $${p++} OFFSET $${p}`,
      [...params, Number(limit), Number(offset)]
    );
    res.json({ logs: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

exports.services = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT DISTINCT service FROM log_entries WHERE user_id=$1 ORDER BY service', [req.user.id]
    );
    res.json({ services: rows.map(r => r.service) });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.stats = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE timestamp > NOW()-INTERVAL '24 hours') last_24h,
         COUNT(*) FILTER (WHERE level='error' AND timestamp > NOW()-INTERVAL '1 hour') errors_1h,
         COUNT(*) FILTER (WHERE level='error' AND timestamp > NOW()-INTERVAL '24 hours') errors_24h
       FROM log_entries WHERE user_id=$1`,
      [req.user.id]
    );
    res.json({ stats: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── ALERT RULES ───────────────────────────────────────────────────
exports.listRules = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM alert_rules WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]
    );
    res.json({ rules: rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.createRule = async (req, res) => {
  try {
    const { name, service, level, threshold=5, window_seconds=300, notify_email=true } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await query(
      `INSERT INTO alert_rules (user_id,name,service,level,threshold,window_seconds,notify_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, name, service||null, level||null, threshold, window_seconds, notify_email]
    );
    res.status(201).json({ rule: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.deleteRule = async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM alert_rules WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found' });
    res.json({ message: 'Deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── ALERT RULE EVALUATION (runs after every log ingest) ──────────
async function checkAlertRules(userId, log) {
  const { rows: rules } = await query(
    `SELECT * FROM alert_rules
     WHERE user_id=$1 AND is_active=TRUE
       AND (level IS NULL OR level=$2)
       AND (service IS NULL OR service=$3)`,
    [userId, log.level, log.service]
  );

  for (const rule of rules) {
    const since = new Date(Date.now() - rule.window_seconds * 1000);
    const { rows } = await query(
      `SELECT COUNT(*) cnt FROM log_entries
       WHERE user_id=$1 AND timestamp>=$2
         AND ($3::text IS NULL OR level=$3)
         AND ($4::text IS NULL OR service=$4)`,
      [userId, since, rule.level, rule.service]
    );

    const count = Number(rows[0].cnt);
    if (count < rule.threshold) continue;

    // Cooldown: don't fire more than once per window
    const cooldownEnd = rule.last_triggered
      ? new Date(rule.last_triggered).getTime() + rule.window_seconds * 1000
      : 0;
    if (Date.now() < cooldownEnd) continue;

    await query('UPDATE alert_rules SET last_triggered=NOW() WHERE id=$1', [rule.id]);
        // Save to alert_events for history
    await query(
      `INSERT INTO alert_events (rule_id, user_id, count, notified)
      VALUES ($1, $2, $3, $4)`,
      [rule.id, userId, count, rule.notify_email]
    );

    if (rule.notify_email) {
      const { rows: u } = await query('SELECT email FROM users WHERE id=$1', [userId]);
      if (u[0]) sendAlertRuleFired({ email: u[0].email }, rule, count).catch(console.error);
    }
  }
}
// Save to alert_events for history
await query(
  `INSERT INTO alert_events (rule_id, user_id, count, notified)
   VALUES ($1, $2, $3, $4)`,
  [rule.id, userId, count, rule.notify_email]
);
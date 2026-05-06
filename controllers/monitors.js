const { query } = require('../config/db');
const { addMonitorJob, removeMonitorJob } = require('../workers/ping');

// ── GET all monitors (with 30d uptime %) ─────────────────────────
exports.list = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.*,
         ROUND(
           100.0 * COUNT(r.id) FILTER (WHERE r.is_up) / NULLIF(COUNT(r.id), 0),
           2
         ) AS uptime_pct
       FROM monitors m
       LEFT JOIN monitor_results r
         ON r.monitor_id = m.id AND r.checked_at > NOW() - INTERVAL '30 days'
       WHERE m.user_id=$1 AND m.status != 'deleted'
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [req.dataUserId || req.user.id]
    );
    res.json({ monitors: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch monitors' });
  }
};

// ── GET single monitor + recent results ──────────────────────────
exports.get = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM monitors WHERE id=$1 AND user_id=$2', [req.params.id, req.dataUserId || req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Monitor not found' });

    const { rows: results } = await query(
      `SELECT is_up, status_code, response_ms, error_message, checked_at
       FROM monitor_results WHERE monitor_id=$1
       ORDER BY checked_at DESC LIMIT 90`,
      [req.params.id]
    );
    res.json({ monitor: rows[0], results });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── CREATE monitor ────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { name, url, method='GET', interval_seconds=60, timeout_ms=5000, expected_status=200, notify_email=true, sla_ms=null } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });

    // Free plan: max 3 monitors
    const { rows: cnt } = await query(
      "SELECT COUNT(*) FROM monitors WHERE user_id=$1 AND status!='deleted'", [req.dataUserId || req.user.id]
    );
    if (req.user.plan === 'free' && Number(cnt[0].count) >= 3)
      return res.status(403).json({ error: 'Free plan allows max 3 monitors. Upgrade to Pro.' });

    const { rows } = await query(
      `INSERT INTO monitors (user_id,name,url,method,interval_seconds,timeout_ms,expected_status,notify_email,sla_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.dataUserId || req.user.id, name, url, method, interval_seconds, timeout_ms, expected_status, notify_email, sla_ms || null]
    );
    await addMonitorJob(rows[0]);
    res.status(201).json({ monitor: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create monitor' });
  }
};

// ── UPDATE monitor ────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const { name, url, method, interval_seconds, timeout_ms, expected_status, notify_email, status } = req.body;
    const { rows } = await query(
      `UPDATE monitors SET
         name=COALESCE($1,name), url=COALESCE($2,url), method=COALESCE($3,method),
         interval_seconds=COALESCE($4,interval_seconds), timeout_ms=COALESCE($5,timeout_ms),
         expected_status=COALESCE($6,expected_status), notify_email=COALESCE($7,notify_email),
         status=COALESCE($8,status)
       WHERE id=$9 AND user_id=$10 RETURNING *`,
      [name,url,method,interval_seconds,timeout_ms,expected_status,notify_email,status, req.params.id, req.dataUserId || req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Monitor not found' });

    await removeMonitorJob(req.params.id);
    if (rows[0].status === 'active') await addMonitorJob(rows[0]);

    res.json({ monitor: rows[0] });
  } catch {
    res.status(500).json({ error: 'Update failed' });
  }
};

// ── DELETE monitor ────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const { rows } = await query(
      "UPDATE monitors SET status='deleted' WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.dataUserId || req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Monitor not found' });
    await removeMonitorJob(req.params.id);
    res.json({ message: 'Monitor deleted' });
  } catch {
    res.status(500).json({ error: 'Delete failed' });
  }
};

// ── Stats ─────────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const [mRow, iRow, rRow] = await Promise.all([
      query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE last_status='up') up,
             COUNT(*) FILTER (WHERE last_status='down') down
             FROM monitors WHERE user_id=$1 AND status='active'`, [req.dataUserId || req.user.id]),
      query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='open') open
             FROM incidents WHERE user_id=$1 AND started_at > NOW()-INTERVAL '30 days'`, [req.dataUserId || req.user.id]),
      query(`SELECT ROUND(AVG(last_response_ms)) avg
             FROM monitors WHERE user_id=$1 AND status='active' AND last_response_ms IS NOT NULL`, [req.dataUserId || req.user.id]),
    ]);
    res.json({ monitors: mRow.rows[0], incidents: iRow.rows[0], avg_response_ms: rRow.rows[0].avg });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── Incidents ─────────────────────────────────────────────────────
exports.incidents = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT i.*, m.name monitor_name, m.url monitor_url
       FROM incidents i JOIN monitors m ON i.monitor_id=m.id
       WHERE i.user_id=$1 ORDER BY i.started_at DESC LIMIT 30`,
      [req.dataUserId || req.user.id]
    );
    res.json({ incidents: rows });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── MANUAL CHECK NOW ──────────────────────────────────────────────
exports.checkNow = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM monitors WHERE id=$1 AND user_id=$2 AND status=$3',
      [req.params.id, req.dataUserId || req.user.id, 'active']
    );
    if (!rows[0]) return res.status(404).json({ error: 'Monitor not found or not active' });

    // Trigger an immediate one-off check by adding a non-repeating job
    const { addMonitorJob } = require('../workers/ping');
    const { Queue } = require('bullmq');
    const { createRedisConnection } = require('../config/redis');
    const pingQueue = new Queue('monitor-pings', { connection: createRedisConnection() });

    await pingQueue.add('ping', { monitorId: req.params.id }, {
      removeOnComplete: true,
      removeOnFail: true,
    });

    res.json({ message: 'Manual check triggered. Results will appear in ~5 seconds.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to trigger check' });
  }
};

// ── CHART DATA (last 24h response times, grouped by hour) ─────────
exports.chartData = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         date_trunc('hour', checked_at) AS hour,
         ROUND(AVG(response_ms))        AS avg_ms,
         ROUND(MIN(response_ms))        AS min_ms,
         ROUND(MAX(response_ms))        AS max_ms,
         COUNT(*)                        AS total,
         COUNT(*) FILTER (WHERE is_up)  AS up_count
       FROM monitor_results
       WHERE monitor_id=$1
         AND checked_at > NOW() - INTERVAL '24 hours'
       GROUP BY hour
       ORDER BY hour ASC`,
      [req.params.id]
    );
    res.json({ chart: rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
};
const { query } = require('../config/db');

// Check if a monitor is currently in maintenance
exports.isInMaintenance = async (monitorId) => {
  const { rows } = await query(
    `SELECT id FROM maintenance_windows
     WHERE monitor_id = $1
       AND starts_at <= NOW()
       AND ends_at   >= NOW()
     LIMIT 1`,
    [monitorId]
  );
  return rows.length > 0;
};

// GET /monitors/:id/maintenance
exports.list = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM maintenance_windows
       WHERE monitor_id=$1 AND user_id=$2
       ORDER BY starts_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json({ windows: rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// POST /monitors/:id/maintenance
exports.create = async (req, res) => {
  try {
    const { title = 'Scheduled maintenance', starts_at, ends_at, repeat_weekly = false } = req.body;
    if (!starts_at || !ends_at) return res.status(400).json({ error: 'starts_at and ends_at required' });
    if (new Date(ends_at) <= new Date(starts_at)) return res.status(400).json({ error: 'ends_at must be after starts_at' });

    const { rows } = await query(
      `INSERT INTO maintenance_windows (monitor_id, user_id, title, starts_at, ends_at, repeat_weekly)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, req.user.id, title, starts_at, ends_at, repeat_weekly]
    );
    res.status(201).json({ window: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// DELETE /monitors/:id/maintenance/:windowId
exports.remove = async (req, res) => {
  try {
    await query(
      'DELETE FROM maintenance_windows WHERE id=$1 AND user_id=$2',
      [req.params.windowId, req.user.id]
    );
    res.json({ message: 'Deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
};
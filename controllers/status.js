const { query } = require('../config/db');

// ── GET /api/status/:slug — public, no auth required ─────────────
exports.getStatusPage = async (req, res) => {
  try {
    const { slug } = req.params;

    // Find user by status page slug
    const { rows: users } = await query(
      'SELECT id, name, status_page_slug FROM users WHERE status_page_slug=$1',
      [slug]
    );
    if (!users[0]) return res.status(404).json({ error: 'Status page not found' });

    const user = users[0];

    // All active monitors with uptime
    const { rows: monitors } = await query(
      `SELECT m.id, m.name, m.url, m.last_status, m.last_checked_at, m.last_response_ms,
         ROUND(
           100.0 * COUNT(r.id) FILTER (WHERE r.is_up) / NULLIF(COUNT(r.id), 0), 2
         ) AS uptime_pct
       FROM monitors m
       LEFT JOIN monitor_results r
         ON r.monitor_id = m.id AND r.checked_at > NOW() - INTERVAL '30 days'
       WHERE m.user_id=$1 AND m.status='active'
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [user.id]
    );

    // Open incidents
    const { rows: incidents } = await query(
      `SELECT i.title, i.status, i.started_at, i.resolved_at, i.duration_seconds, m.name AS monitor_name
       FROM incidents i JOIN monitors m ON i.monitor_id=m.id
       WHERE i.user_id=$1 AND i.started_at > NOW() - INTERVAL '30 days'
       ORDER BY i.started_at DESC LIMIT 10`,
      [user.id]
    );

    // Overall system status
    const allUp       = monitors.every(m => m.last_status === 'up');
    const anyDown     = monitors.some(m => m.last_status === 'down');
    const systemStatus = anyDown ? 'degraded' : allUp ? 'operational' : 'partial';

    res.json({
      org:          user.name,
      slug:         user.status_page_slug,
      system_status: systemStatus,
      monitors,
      incidents,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load status page' });
  }
};

// ── PATCH /api/settings/status-slug — set your public page slug ───
exports.setSlug = async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Validate slug: lowercase alphanumeric + hyphens only
    if (!/^[a-z0-9-]{3,30}$/.test(slug))
      return res.status(400).json({ error: 'Slug must be 3-30 chars, lowercase letters, numbers, hyphens only' });

    const { rows } = await query(
      'UPDATE users SET status_page_slug=$1 WHERE id=$2 RETURNING status_page_slug',
      [slug, req.user.id]
    );
    res.json({ slug: rows[0].status_page_slug });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This slug is already taken' });
    res.status(500).json({ error: 'Failed to update slug' });
  }
};

exports.getSlug = async (req, res) => {
  try {
    const { rows } = await query('SELECT status_page_slug FROM users WHERE id=$1', [req.user.id]);
    res.json({ slug: rows[0]?.status_page_slug || null });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};
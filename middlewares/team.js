const { query } = require('../config/db');

// ── requireTeamAccess ─────────────────────────────────────────────
// Reads teamId from params or X-Team-Id header.
// Verifies user is a member and attaches req.teamId + req.teamRole.
const requireTeamAccess = async (req, res, next) => {
  try {
    const teamId = req.params.teamId || req.headers['x-team-id'];
    if (!teamId) return res.status(400).json({ error: 'Team ID required' });

    const { rows } = await query(
      `SELECT tm.role, t.id, t.name, t.owner_id
       FROM team_members tm
       JOIN teams t ON tm.team_id = t.id
       WHERE tm.team_id = $1 AND tm.user_id = $2`,
      [teamId, req.user.id]
    );

    if (!rows[0]) {
      return res.status(403).json({ error: 'Not a member of this team' });
    }

    req.teamId   = rows[0].id;
    req.teamRole = rows[0].role;
    req.team     = rows[0];
    next();
  } catch (err) {
    console.error('requireTeamAccess:', err);
    res.status(500).json({ error: 'Failed to verify team access' });
  }
};

// ── requireRole ───────────────────────────────────────────────────
// Use after requireTeamAccess.
// requireRole('admin') — only admins
// requireRole('admin', 'member') — admins and members, not viewers
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.teamRole)) {
    return res.status(403).json({
      error: `Requires role: ${roles.join(' or ')}. Your role: ${req.teamRole}`,
    });
  }
  next();
};

module.exports = { requireTeamAccess, requireRole };
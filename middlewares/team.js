const { query } = require('../config/db');

// Reads teamId from X-Team-Id header or params
// Sets req.teamId, req.teamRole, req.dataUserId (whose data to show)
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

    req.teamId    = rows[0].id;
    req.teamRole  = rows[0].role;
    req.team      = rows[0];
    next();
  } catch (err) {
    console.error('requireTeamAccess:', err);
    res.status(500).json({ error: 'Failed to verify team access' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.teamRole)) {
    return res.status(403).json({
      error: `Requires role: ${roles.join(' or ')}. Your role: ${req.teamRole}`,
    });
  }
  next();
};

// Sets req.dataUserId = the team owner's user_id
// All data queries should use req.dataUserId instead of req.user.id
// This makes Vanshika (viewer) see Vibha's (owner) monitors/logs/relay
const resolveTeamOwner = async (req, res, next) => {
  try {
    const teamId = req.headers['x-team-id'];
    if (!teamId) {
      req.dataUserId = req.user.id;
      return next();
    }

    const { rows } = await query(
      `SELECT t.owner_id
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE t.id = $1 AND tm.user_id = $2`,
      [teamId, req.user.id]
    );

    if (!rows[0]) {
      req.dataUserId = req.user.id;
      return next();
    }

    // Use team owner's data — so all members see the same monitors/logs
    req.dataUserId = rows[0].owner_id;
    next();
  } catch {
    req.dataUserId = req.user.id;
    next();
  }
};

module.exports = { requireTeamAccess, requireRole, resolveTeamOwner };
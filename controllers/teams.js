const { query } = require('../config/db');

// ── GET /teams — list all teams the user belongs to ───────────────
exports.list = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, tm.role, tm.joined_at,
         COUNT(DISTINCT tm2.id) member_count
       FROM teams t
       JOIN team_members tm  ON t.id = tm.team_id AND tm.user_id = $1
       JOIN team_members tm2 ON t.id = tm2.team_id
       GROUP BY t.id, tm.role, tm.joined_at
       ORDER BY t.created_at ASC`,
      [req.user.id]
    );
    res.json({ teams: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list teams' });
  }
};

// ── POST /teams — create a new team ──────────────────────────────
exports.create = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const { rows } = await query(
      `INSERT INTO teams (name, slug, owner_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, slug, req.user.id]
    );
    const team = rows[0];

    // Creator is automatically admin
    await query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [team.id, req.user.id]
    );

    res.status(201).json({ team });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Team name already taken' });
    res.status(500).json({ error: 'Failed to create team' });
  }
};

// ── GET /teams/:teamId/members ────────────────────────────────────
exports.listMembers = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, tm.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY tm.joined_at ASC`,
      [req.params.teamId]
    );
    res.json({ members: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── POST /teams/:teamId/invite — invite by email ──────────────────
exports.invite = async (req, res) => {
  try {
    const { email, role = 'member' } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!['admin', 'member', 'viewer'].includes(role))
      return res.status(400).json({ error: 'role must be admin, member, or viewer' });

    // Only admins can invite
    if (req.teamRole !== 'admin')
      return res.status(403).json({ error: 'Only admins can invite members' });

    // Find user by email
    const { rows: users } = await query(
      'SELECT id, name, email FROM users WHERE email = $1', [email]
    );
    if (!users[0]) return res.status(404).json({ error: 'No VIGIL account found with that email' });

    const invitee = users[0];

    // Check not already a member
    const { rows: existing } = await query(
      'SELECT id FROM team_members WHERE team_id=$1 AND user_id=$2',
      [req.params.teamId, invitee.id]
    );
    if (existing[0]) return res.status(409).json({ error: 'User is already a team member' });

    await query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [req.params.teamId, invitee.id, role]
    );

    res.status(201).json({
      message: `${invitee.name} added to team as ${role}`,
      member: { ...invitee, role },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to invite member' });
  }
};

// ── PATCH /teams/:teamId/members/:userId — change role ────────────
exports.updateRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'member', 'viewer'].includes(role))
      return res.status(400).json({ error: 'role must be admin, member, or viewer' });

    // Only admins can change roles
    if (req.teamRole !== 'admin')
      return res.status(403).json({ error: 'Only admins can change roles' });

    // Can't change your own role
    if (req.params.userId === req.user.id)
      return res.status(400).json({ error: "You can't change your own role" });

    const { rows } = await query(
      `UPDATE team_members SET role=$1
       WHERE team_id=$2 AND user_id=$3 RETURNING *`,
      [role, req.params.teamId, req.params.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

    res.json({ message: 'Role updated', role });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── DELETE /teams/:teamId/members/:userId — remove member ─────────
exports.removeMember = async (req, res) => {
  try {
    // Only admins can remove, or user removing themselves
    const isSelf  = req.params.userId === req.user.id;
    const isAdmin = req.teamRole === 'admin';
    if (!isSelf && !isAdmin)
      return res.status(403).json({ error: 'Only admins can remove members' });

    // Can't remove the team owner
    const { rows: team } = await query(
      'SELECT owner_id FROM teams WHERE id=$1', [req.params.teamId]
    );
    if (team[0]?.owner_id === req.params.userId)
      return res.status(400).json({ error: "Can't remove the team owner" });

    await query(
      'DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',
      [req.params.teamId, req.params.userId]
    );

    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── GET /teams/:teamId — get single team ──────────────────────────
exports.get = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, tm.role,
         COUNT(DISTINCT tm2.id) member_count
       FROM teams t
       JOIN team_members tm  ON t.id=tm.team_id AND tm.user_id=$1
       JOIN team_members tm2 ON t.id=tm2.team_id
       WHERE t.id=$2
       GROUP BY t.id, tm.role`,
      [req.user.id, req.params.teamId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Team not found' });
    res.json({ team: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
};
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');

// ── Bearer JWT ────────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await query(
      'SELECT id, email, name, plan, email_verified FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── X-API-Key ─────────────────────────────────────────────────────
const requireApiKey = async (req, res, next) => {
  try {
    const raw = req.headers['x-api-key'];
    if (!raw)
      return res.status(401).json({ error: 'API key required (X-API-Key header)' });

    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    const { rows } = await query(
      `SELECT ak.id, ak.permissions, u.id AS uid, u.email, u.name, u.plan
       FROM api_keys ak JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = $1`,
      [hash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid API key' });

    // Fire-and-forget last_used update
    query('UPDATE api_keys SET last_used = NOW() WHERE key_hash = $1', [hash]).catch(() => {});

    req.user = { id: rows[0].uid, email: rows[0].email, name: rows[0].name, plan: rows[0].plan };
    req.apiKeyPermissions = rows[0].permissions;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
};

// ── Either JWT or API key (for ingest endpoints) ──────────────────
const requireAuthOrApiKey = (req, res, next) => {
  if (req.headers['x-api-key']) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
};

module.exports = { requireAuth, requireApiKey, requireAuthOrApiKey };
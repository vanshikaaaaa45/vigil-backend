const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const validator = require('validator');
const { query } = require('../config/db');
const email    = require('../services/email');

// ── Helpers ───────────────────────────────────────────────────────
const signAccess  = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });

const signRefresh = (userId) =>
  jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });

const hashStr = (s) => crypto.createHash('sha256').update(s).digest('hex');

const setCookie = (res, token) =>
  res.cookie('vigil_rt', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

// ── REGISTER ──────────────────────────────────────────────────────
exports.register = async (req, res) => {
  try {
    const { name, email: emailInput, password } = req.body;

    if (!name?.trim() || !emailInput || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });

    if (!validator.isEmail(emailInput))
      return res.status(400).json({ error: 'Invalid email address' });

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { rows: existing } = await query(
      'SELECT id FROM users WHERE email = $1', [emailInput.toLowerCase()]
    );
    if (existing[0])
      return res.status(409).json({ error: 'An account with this email already exists' });

    const password_hash   = await bcrypt.hash(password, 12);
    const verify_token    = crypto.randomBytes(32).toString('hex');
    const verify_token_exp = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, verify_token, verify_token_exp)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, plan, email_verified`,
      [name.trim(), emailInput.toLowerCase(), password_hash, verify_token, verify_token_exp]
    );
    const user = rows[0];

    // Default notification settings
    await query('INSERT INTO notification_settings (user_id) VALUES ($1)', [user.id]);

    email.sendVerification(user, verify_token).catch(console.error);

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
      [user.id, hashStr(refreshToken)]
    );
    setCookie(res, refreshToken);

    res.status(201).json({
      message: 'Account created — please verify your email.',
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan, email_verified: user.email_verified },
      accessToken,
    });
  } catch (err) {
    console.error('register:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
};

// ── LOGIN ─────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email: emailInput, password } = req.body;
    if (!emailInput || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await query(
      'SELECT id, name, email, password_hash, plan, email_verified FROM users WHERE email = $1',
      [emailInput.toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid email or password' });

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
      [user.id, hashStr(refreshToken)]
    );
    setCookie(res, refreshToken);

    res.json({
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan, email_verified: user.email_verified },
      accessToken,
    });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ error: 'Login failed' });
  }
};

// ── REFRESH ───────────────────────────────────────────────────────
exports.refresh = async (req, res) => {
  try {
    const token = req.cookies?.vigil_rt;
    if (!token) return res.status(401).json({ error: 'No refresh token' });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const { rows } = await query(
      'SELECT id FROM refresh_tokens WHERE token_hash=$1 AND expires_at > NOW()',
      [hashStr(token)]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Refresh token invalid or expired' });

    res.json({ accessToken: signAccess(decoded.userId) });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
};

// ── LOGOUT ────────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    const token = req.cookies?.vigil_rt;
    if (token) await query('DELETE FROM refresh_tokens WHERE token_hash=$1', [hashStr(token)]);
    res.clearCookie('vigil_rt', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    });
    res.json({ message: 'Logged out' });
  } catch {
    res.status(500).json({ error: 'Logout failed' });
  }
};

// ── VERIFY EMAIL ──────────────────────────────────────────────────
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { rows } = await query(
      `UPDATE users SET email_verified=TRUE, verify_token=NULL, verify_token_exp=NULL
       WHERE verify_token=$1 AND verify_token_exp > NOW()
       RETURNING id, name, email`,
      [token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired token' });

    res.json({ message: 'Email verified!', user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Verification failed' });
  }
};

// ── FORGOT PASSWORD ───────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const { email: emailInput } = req.body;
    if (!emailInput) return res.status(400).json({ error: 'Email required' });

    const { rows } = await query('SELECT id, name, email FROM users WHERE email=$1', [emailInput.toLowerCase()]);

    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `UPDATE users SET reset_token=$1, reset_token_exp=NOW()+INTERVAL '1 hour' WHERE id=$2`,
        [token, rows[0].id]
      );
      email.sendPasswordReset(rows[0], token).catch(console.error);
    }
    // Always same response to prevent email enumeration
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_exp=NULL
       WHERE reset_token=$2 AND reset_token_exp > NOW() RETURNING id`,
      [hash, token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired token' });

    // Invalidate all existing sessions
    await query('DELETE FROM refresh_tokens WHERE user_id=$1', [rows[0].id]);
    res.json({ message: 'Password reset. Please log in.' });
  } catch {
    res.status(500).json({ error: 'Reset failed' });
  }
};

// ── GET ME ────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, name, email, plan, email_verified, avatar_url, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
};

// ── UPDATE PROFILE ────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const { rows } = await query(
      'UPDATE users SET name=$1 WHERE id=$2 RETURNING id,name,email,plan,email_verified',
      [name.trim(), req.user.id]
    );
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Update failed' });
  }
};
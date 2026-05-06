const router  = require('express').Router();
const limit   = require('express-rate-limit');
const { requireAuth, requireApiKey, requireAuthOrApiKey } = require('../middlewares/auth');
const { keyRateLimit } = require('../middlewares/keyRateLimit');
const { requireTeamAccess, requireRole, resolveTeamOwner } = require('../middlewares/team');
const teams = require('../controllers/teams');

const auth     = require('../controllers/auth');
const monitors = require('../controllers/monitors');
const logs     = require('../controllers/logs');
const relay    = require('../controllers/relay');
const keys     = require('../controllers/keys');
const status   = require('../controllers/status');
const { query } = require('../config/db');

// ── Rate limiters ─────────────────────────────────────────────────
const authLim   = limit({ windowMs: 15*60*1000, max: 10,  message: { error: 'Too many attempts' } });
const ingestLim = limit({ windowMs:    60*1000, max: 500, message: { error: 'Rate limit exceeded' } });

// ── Auth ──────────────────────────────────────────────────────────
router.post('/auth/register',        authLim, auth.register);
router.post('/auth/login',           authLim, auth.login);
router.post('/auth/logout',                   auth.logout);
router.post('/auth/refresh',                  auth.refresh);
router.get ('/auth/verify-email',             auth.verifyEmail);
router.post('/auth/forgot-password', authLim, auth.forgotPassword);
router.post('/auth/reset-password',           auth.resetPassword);
router.get ('/auth/me',              requireAuth, auth.getMe);
router.patch('/auth/profile',        requireAuth, auth.updateProfile);

// ── Monitors ──────────────────────────────────────────────────────
router.get ('/monitors',             requireAuth, resolveTeamOwner, monitors.list);
router.get ('/monitors/stats',       requireAuth, resolveTeamOwner, monitors.stats);
router.get ('/monitors/incidents',   requireAuth, resolveTeamOwner, monitors.incidents);
router.get ('/monitors/:id',         requireAuth, monitors.get);
router.get ('/monitors/:id/chart',   requireAuth, monitors.chartData);
router.post('/monitors',             requireAuth, monitors.create);
router.post('/monitors/:id/check',   requireAuth, monitors.checkNow);
router.patch('/monitors/:id',        requireAuth, monitors.update);
router.delete('/monitors/:id',       requireAuth, monitors.remove);

// ── Logs ──────────────────────────────────────────────────────────
router.post('/logs/ingest', ingestLim, requireAuthOrApiKey, keyRateLimit, (req, res, next) => {
  req.app.get('io') && (req.io = req.app.get('io'));
  next();
}, logs.ingest);

router.get('/logs',              requireAuth, resolveTeamOwner, logs.list);
router.get('/logs/services',     requireAuth, resolveTeamOwner, logs.services);
router.get('/logs/stats',        requireAuth, resolveTeamOwner, logs.stats);
router.get('/logs/rules',        requireAuth, resolveTeamOwner, logs.listRules);
router.post('/logs/rules',       requireAuth, logs.createRule);
router.delete('/logs/rules/:id', requireAuth, logs.deleteRule);
router.get   ('/logs/alert-history',  requireAuth, resolveTeamOwner, logs.alertHistory);


// ── Relay ─────────────────────────────────────────────────────────
router.get   ('/relay/channels',                                  requireAuth, resolveTeamOwner, relay.listChannels);
router.post  ('/relay/channels',                                  requireAuth, relay.createChannel);
router.delete('/relay/channels/:id',                              requireAuth, relay.deleteChannel);
router.get   ('/relay/channels/:channelId/listeners',             requireAuth, resolveTeamOwner, relay.listListeners);
router.post  ('/relay/channels/:channelId/listeners',             requireAuth, relay.addListener);
router.delete('/relay/channels/:channelId/listeners/:listenerId', requireAuth, relay.removeListener);
router.get   ('/relay/channels/:channelId/events',                requireAuth, resolveTeamOwner, relay.listEvents);
router.post  ('/relay/events/:eventId/replay',                    requireAuth, relay.replay);
router.get   ('/relay/stats',                                     requireAuth, resolveTeamOwner, relay.stats);
router.post  ('/relay/in/:slug',                  requireApiKey,  keyRateLimit, relay.receive);

// ── API Keys ──────────────────────────────────────────────────────
router.get   ('/keys',     requireAuth, resolveTeamOwner, keys.list);
router.post  ('/keys',     requireAuth, keys.create);
router.delete('/keys/:id', requireAuth, keys.remove);

// ── Public status page (NO auth) ─────────────────────────────────
router.get('/status/:slug', status.getStatusPage);

// ── Notification + global settings ───────────────────────────────
router.get('/settings/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM notification_settings WHERE user_id=$1', [req.user.id]);
    res.json({ settings: rows[0] || {} });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.patch('/settings/notifications', requireAuth, async (req, res) => {
  try {
    const { monitor_alerts, log_alert_rules, relay_failures, weekly_summary, slack_webhook_url, discord_webhook_url } = req.body;
    const { rows } = await query(
      `UPDATE notification_settings
       SET monitor_alerts      = COALESCE($1, monitor_alerts),
           log_alert_rules     = COALESCE($2, log_alert_rules),
           relay_failures      = COALESCE($3, relay_failures),
           weekly_summary      = COALESCE($4, weekly_summary),
           slack_webhook_url   = COALESCE($5, slack_webhook_url),
           discord_webhook_url = COALESCE($6, discord_webhook_url)
       WHERE user_id=$7 RETURNING *`,
      [monitor_alerts, log_alert_rules, relay_failures, weekly_summary,
       slack_webhook_url, discord_webhook_url, req.user.id]
    );
    res.json({ settings: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Status page slug management
router.get  ('/settings/status-slug', requireAuth, status.getSlug);
router.patch('/settings/status-slug', requireAuth, status.setSlug);

// ── Teams ────────────────────────────────────────────────────────
router.get   ('/teams',                                    requireAuth, teams.list);
router.post  ('/teams',                                    requireAuth, teams.create);
router.get   ('/teams/:teamId',                            requireAuth, requireTeamAccess, teams.get);
router.get   ('/teams/:teamId/members',                    requireAuth, requireTeamAccess, teams.listMembers);
router.post  ('/teams/:teamId/invite',                     requireAuth, requireTeamAccess, requireRole('admin'), teams.invite);
router.patch ('/teams/:teamId/members/:userId',            requireAuth, requireTeamAccess, requireRole('admin'), teams.updateRole);
router.delete('/teams/:teamId/members/:userId',            requireAuth, requireTeamAccess, teams.removeMember);

// ── Uptime badge (public, no auth) ───────────────────────────────
router.get('/badge/:monitorId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.name, m.last_status, m.last_response_ms,
         ROUND(100.0 * COUNT(r.id) FILTER (WHERE r.is_up) / NULLIF(COUNT(r.id),0), 1) uptime_pct
       FROM monitors m
       LEFT JOIN monitor_results r ON r.monitor_id=m.id AND r.checked_at > NOW()-INTERVAL '30 days'
       WHERE m.id=$1
       GROUP BY m.id`,
      [req.params.monitorId]
    );

    if (!rows[0]) {
      return res.status(404).send('Monitor not found');
    }

    const m      = rows[0];
    const status = m.last_status || 'pending';
    const uptime = m.uptime_pct ? `${m.uptime_pct}%` : 'N/A';

    const colors = { up: '#22c55e', down: '#ef4444', slow: '#f59e0b', pending: '#6b7280' };
    const labels = { up: 'up', down: 'down', slow: 'slow', pending: 'pending' };
    const color  = colors[status] || colors.pending;
    const label  = labels[status] || 'unknown';

    // Badge dimensions
    const leftText  = 'uptime';
    const rightText = `${uptime} ${label}`;
    const leftW  = leftText.length  * 6.5 + 16;
    const rightW = rightText.length * 6.5 + 16;
    const totalW = leftW + rightW;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <title>${m.name} — ${label}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${leftW / 2}" y="15" fill="#010101" fill-opacity=".3">${leftText}</text>
    <text x="${leftW / 2}" y="14">${leftText}</text>
    <text x="${leftW + rightW / 2}" y="15" fill="#010101" fill-opacity=".3">${rightText}</text>
    <text x="${leftW + rightW / 2}" y="14">${rightText}</text>
  </g>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// ── Health ────────────────────────────────────────────────────────
router.get('/health', (req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

module.exports = router;
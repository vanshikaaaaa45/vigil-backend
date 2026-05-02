const router  = require('express').Router();
const limit   = require('express-rate-limit');
const { requireAuth, requireApiKey, requireAuthOrApiKey } = require('../middlewares/auth');

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
router.get ('/monitors',             requireAuth, monitors.list);
router.get ('/monitors/stats',       requireAuth, monitors.stats);
router.get ('/monitors/incidents',   requireAuth, monitors.incidents);
router.get ('/monitors/:id',         requireAuth, monitors.get);
router.get ('/monitors/:id/chart',   requireAuth, monitors.chartData);
router.post('/monitors',             requireAuth, monitors.create);
router.post('/monitors/:id/check',   requireAuth, monitors.checkNow);
router.patch('/monitors/:id',        requireAuth, monitors.update);
router.delete('/monitors/:id',       requireAuth, monitors.remove);

// ── Logs ──────────────────────────────────────────────────────────
router.post('/logs/ingest', ingestLim, requireAuthOrApiKey, (req, res, next) => {
  req.app.get('io') && (req.io = req.app.get('io'));
  next();
}, logs.ingest);

router.get('/logs',              requireAuth, logs.list);
router.get('/logs/services',     requireAuth, logs.services);
router.get('/logs/stats',        requireAuth, logs.stats);
router.get('/logs/rules',        requireAuth, logs.listRules);
router.post('/logs/rules',       requireAuth, logs.createRule);
router.delete('/logs/rules/:id', requireAuth, logs.deleteRule);

// ── Relay ─────────────────────────────────────────────────────────
router.get   ('/relay/channels',                                  requireAuth, relay.listChannels);
router.post  ('/relay/channels',                                  requireAuth, relay.createChannel);
router.delete('/relay/channels/:id',                              requireAuth, relay.deleteChannel);
router.get   ('/relay/channels/:channelId/listeners',             requireAuth, relay.listListeners);
router.post  ('/relay/channels/:channelId/listeners',             requireAuth, relay.addListener);
router.delete('/relay/channels/:channelId/listeners/:listenerId', requireAuth, relay.removeListener);
router.get   ('/relay/channels/:channelId/events',                requireAuth, relay.listEvents);
router.post  ('/relay/events/:eventId/replay',                    requireAuth, relay.replay);
router.get   ('/relay/stats',                                     requireAuth, relay.stats);
router.post  ('/relay/in/:slug',                  requireApiKey,  relay.receive);

// ── API Keys ──────────────────────────────────────────────────────
router.get   ('/keys',     requireAuth, keys.list);
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
       SET monitor_alerts   = COALESCE($1, monitor_alerts),
           log_alert_rules  = COALESCE($2, log_alert_rules),
           relay_failures   = COALESCE($3, relay_failures),
           weekly_summary   = COALESCE($4, weekly_summary),
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
router.get ('/settings/status-slug', requireAuth, status.getSlug);
router.patch('/settings/status-slug', requireAuth, status.setSlug);

// ── Health ────────────────────────────────────────────────────────
router.get('/health', (req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

module.exports = router;
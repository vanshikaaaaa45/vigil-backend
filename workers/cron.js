const cron = require('node-cron');
const { query } = require('../config/db');
const { sendSlack } = require('../services/email');
const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Log retention: run at 2am every night ─────────────────────────
const startLogRetention = () => {
  cron.schedule('0 2 * * *', async () => {
    console.log('[cron] Running log retention cleanup…');
    try {
      // Free plan: 7 days, Pro: 30 days, Team: 90 days
      const retentionMap = { free: 7, pro: 30, team: 90 };

      const { rows: users } = await query(
        "SELECT id, plan FROM users WHERE plan IN ('free','pro','team')"
      );

      let totalDeleted = 0;
      for (const user of users) {
        const days = retentionMap[user.plan] || 7;
        const { rowCount } = await query(
          `DELETE FROM log_entries WHERE user_id=$1 AND timestamp < NOW() - INTERVAL '${days} days'`,
          [user.id]
        );
        totalDeleted += rowCount || 0;
      }
      console.log(`[cron] Log retention: deleted ${totalDeleted} old entries`);
    } catch (err) {
      console.error('[cron] Log retention failed:', err.message);
    }
  });
  console.log('✓ Log retention cron scheduled (daily 2am)');
};

// ── Weekly summary: every Monday 9am ─────────────────────────────
const startWeeklySummary = () => {
  cron.schedule('0 9 * * 1', async () => {
    console.log('[cron] Sending weekly summaries…');
    try {
      const { rows: users } = await query(
        `SELECT u.id, u.name, u.email, ns.weekly_summary, ns.slack_webhook_url
         FROM users u
         JOIN notification_settings ns ON u.id=ns.user_id
         WHERE ns.weekly_summary=TRUE AND u.email_verified=TRUE`
      );

      for (const user of users) {
        try {
          // Gather stats for this user
          const [monRows, logRows, incRows, delRows] = await Promise.all([
            query(`SELECT
                     COUNT(*) total,
                     COUNT(*) FILTER (WHERE last_status='up') up,
                     COUNT(*) FILTER (WHERE last_status='down') down,
                     ROUND(AVG(last_response_ms)) avg_ms
                   FROM monitors WHERE user_id=$1 AND status='active'`, [user.id]),
            query(`SELECT
                     COUNT(*) total_logs,
                     COUNT(*) FILTER (WHERE level='error') errors,
                     COUNT(*) FILTER (WHERE level='warn') warnings
                   FROM log_entries WHERE user_id=$1 AND timestamp > NOW()-INTERVAL '7 days'`, [user.id]),
            query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='open') open
                   FROM incidents WHERE user_id=$1 AND started_at > NOW()-INTERVAL '7 days'`, [user.id]),
            query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='delivered') ok
                   FROM relay_deliveries rd
                   JOIN relay_events re ON rd.event_id=re.id
                   JOIN relay_channels rc ON re.channel_id=rc.id
                   WHERE rc.user_id=$1 AND re.received_at > NOW()-INTERVAL '7 days'`, [user.id]),
          ]);

          const m   = monRows.rows[0];
          const l   = logRows.rows[0];
          const inc = incRows.rows[0];
          const d   = delRows.rows[0];

          const deliveryRate = d.total > 0
            ? Math.round((Number(d.ok) / Number(d.total)) * 100)
            : 100;

          const html = `<!DOCTYPE html><html><body style="background:#09090b;color:#fafafa;font-family:sans-serif;padding:0;margin:0">
<div style="max-width:560px;margin:40px auto;background:#111113;border:1px solid #27272a;border-radius:12px;overflow:hidden">
  <div style="background:#f97316;padding:22px 30px"><div style="color:#fff;font-size:18px;font-weight:800">V VIGIL — Weekly Summary</div></div>
  <div style="padding:28px">
    <p style="font-size:15px;font-weight:700;margin:0 0 18px">Hey ${user.name}, here's your week at a glance 👋</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      ${[
        ['Monitors', `${m.up}/${m.total} up`, m.down > 0 ? '#f87171' : '#4ade80'],
        ['Avg response', m.avg_ms ? `${m.avg_ms}ms` : '—', '#f97316'],
        ['Logs (7d)', Number(l.total_logs).toLocaleString(), '#60a5fa'],
        ['Errors (7d)', Number(l.errors).toLocaleString(), l.errors > 0 ? '#f87171' : '#4ade80'],
        ['Incidents', `${inc.total} (${inc.open} open)`, inc.open > 0 ? '#f87171' : '#4ade80'],
        ['Webhook delivery', `${deliveryRate}%`, deliveryRate > 95 ? '#4ade80' : '#f87171'],
      ].map(([label, val, color]) => `
        <div style="background:#18181b;border:1px solid #27272a;border-radius:8px;padding:12px 14px">
          <div style="font-size:10px;color:#71717a;font-family:monospace;margin-bottom:5px">${label}</div>
          <div style="font-size:20px;font-weight:800;color:${color}">${val}</div>
        </div>`).join('')}
    </div>
    <a href="${process.env.FRONTEND_URL}/watch" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:700;font-size:14px">View dashboard →</a>
  </div>
  <div style="padding:18px 30px;border-top:1px solid #27272a;font-size:12px;color:#52525b">
    <a href="${process.env.FRONTEND_URL}/settings" style="color:#f97316">Manage notifications</a>
  </div>
</div></body></html>`;

          await transport.sendMail({
            from: process.env.EMAIL_FROM,
            to: user.email,
            subject: `VIGIL weekly summary — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
            html,
          });

          // Also post to Slack if configured
          if (user.slack_webhook_url) {
            await sendSlack(user.slack_webhook_url,
              `*VIGIL Weekly Summary*\n` +
              `Monitors: ${m.up}/${m.total} up | ` +
              `Errors: ${l.errors} | ` +
              `Incidents: ${inc.total} | ` +
              `Webhook delivery: ${deliveryRate}%`,
              ':bar_chart:'
            );
          }

          console.log(`[cron] Weekly summary sent to ${user.email}`);
        } catch (e) {
          console.error(`[cron] Failed to send summary to ${user.email}:`, e.message);
        }
      }
    } catch (err) {
      console.error('[cron] Weekly summary failed:', err.message);
    }
  });
  console.log('✓ Weekly summary cron scheduled (Mondays 9am)');
};

module.exports = { startLogRetention, startWeeklySummary };
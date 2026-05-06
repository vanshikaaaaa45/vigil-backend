const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Base HTML wrapper ─────────────────────────────────────────────
const wrap = (body) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{margin:0;background:#09090b;font-family:'Segoe UI',sans-serif}
  .w{max-width:560px;margin:40px auto;background:#111113;border:1px solid #27272a;border-radius:12px;overflow:hidden}
  .h{background:#f97316;padding:22px 30px}
  .logo{color:#fff;font-size:18px;font-weight:800;letter-spacing:-0.5px}
  .b{padding:30px;color:#fafafa}
  h2{font-size:22px;font-weight:700;margin:0 0 14px;letter-spacing:-0.5px}
  p{font-size:14px;line-height:1.7;color:#a1a1aa;margin:0 0 14px}
  a.btn{display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:700;font-size:14px;margin:6px 0 14px}
  code{display:block;font-family:monospace;background:#18181b;border:1px solid #27272a;border-radius:6px;padding:11px 14px;font-size:12px;color:#2dd4bf;margin:10px 0;word-break:break-all}
  .ft{padding:18px 30px;border-top:1px solid #27272a;font-size:12px;color:#52525b}
  .green{color:#4ade80;font-weight:700} .red{color:#f87171;font-weight:700}
</style></head><body>
<div class="w">
  <div class="h"><div class="logo">V VIGIL</div></div>
  <div class="b">${body}</div>
  <div class="ft">You're getting this because you have a VIGIL account.
    <a href="${process.env.FRONTEND_URL}/settings" style="color:#f97316">Manage notifications</a>
  </div>
</div></body></html>`;

const send = ({ to, subject, html }) =>
  transport.sendMail({ from: process.env.EMAIL_FROM, to, subject, html }).catch(console.error);

// ── Email templates ───────────────────────────────────────────────

const sendVerification = (user, token) => {
  const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  return send({
    to: user.email,
    subject: 'Verify your VIGIL account',
    html: wrap(`
      <h2>Welcome to VIGIL, ${user.name}!</h2>
      <p>Click below to verify your email and activate your account.</p>
      <a class="btn" href="${url}">Verify Email →</a>
      <p>Or paste this link:</p><code>${url}</code>
      <p>Expires in 24 hours.</p>
    `),
  });
};

const sendPasswordReset = (user, token) => {
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  return send({
    to: user.email,
    subject: 'Reset your VIGIL password',
    html: wrap(`
      <h2>Password reset</h2>
      <p>We received a reset request for <strong>${user.email}</strong>.</p>
      <a class="btn" href="${url}">Reset Password →</a>
      <p>Expires in 1 hour. Ignore if you didn't request this.</p>
    `),
  });
};

const sendMonitorDown = (user, monitor, result) =>
  send({
    to: user.email,
    subject: `🔴 Down: ${monitor.name}`,
    html: wrap(`
      <h2>Monitor is <span class="red">DOWN</span></h2>
      <p><strong>${monitor.name}</strong> failed its check.</p>
      <code>URL: ${monitor.url}
Status: ${result.status_code || 'No response'}
Error: ${result.error_message || 'Request failed'}
Time: ${new Date().toUTCString()}</code>
      <a class="btn" href="${process.env.FRONTEND_URL}/watch">View in VIGIL →</a>
      <p>We'll notify you when it recovers.</p>
    `),
  });

const sendMonitorUp = (user, monitor) =>
  send({
    to: user.email,
    subject: `✅ Recovered: ${monitor.name}`,
    html: wrap(`
      <h2>Monitor is <span class="green">BACK UP</span></h2>
      <p><strong>${monitor.name}</strong> is responding normally again.</p>
      <code>URL: ${monitor.url}</code>
      <a class="btn" href="${process.env.FRONTEND_URL}/watch">View in VIGIL →</a>
    `),
  });

const sendAlertRuleFired = (user, rule, count) =>
  send({
    to: user.email,
    subject: `⚠️ Alert triggered: ${rule.name}`,
    html: wrap(`
      <h2>Alert rule triggered</h2>
      <p>Rule <strong>"${rule.name}"</strong> fired.</p>
      <code>Condition: ${count} ${rule.level?.toUpperCase() || 'ANY'} logs in ${rule.window_seconds / 60} min
${rule.service ? `Service: ${rule.service}\n` : ''}Threshold: ${rule.threshold}  Actual: ${count}
Time: ${new Date().toUTCString()}</code>
      <a class="btn" href="${process.env.FRONTEND_URL}/stream">View logs →</a>
    `),
  });

const sendMonitorSlow = (user, monitor, responseMs) =>
  send({
    to: user.email,
    subject: `🐢 Slow: ${monitor.name}`,
    html: wrap(`
      <h2>Monitor is <span style="color:#f59e0b;font-weight:700">SLOW</span></h2>
      <p><strong>${monitor.name}</strong> exceeded its SLA threshold.</p>
      <code>URL: ${monitor.url}
Response time: ${responseMs}ms
SLA threshold: ${monitor.sla_ms}ms
Time: ${new Date().toUTCString()}</code>
      <a class="btn" href="${process.env.FRONTEND_URL}/watch">View in VIGIL →</a>
      <p>The monitor is still up but responding slowly.</p>
    `),
  });

// ── Slack alerts ──────────────────────────────────────────────────
const sendSlack = async (webhookUrl, text, emoji = ':red_circle:') => {
  if (!webhookUrl) return;
  try {
    const axios = require('axios');
    await axios.post(webhookUrl, {
      text: `${emoji} *VIGIL* — ${text}`,
    });
  } catch (e) {
    console.error('Slack send failed:', e.message);
  }
};

// ── Discord alerts ────────────────────────────────────────────────
// Discord uses embeds — richer format than Slack plain text
const sendDiscord = async (webhookUrl, rule, count) => {
  if (!webhookUrl) return;
  try {
    const axios = require('axios');
    await axios.post(webhookUrl, {
      embeds: [{
        title:       `⚠️ Alert fired: ${rule.name}`,
        description: `**${count}** ${rule.level?.toUpperCase() || 'ANY'} events in ${rule.window_seconds / 60} min`,
        color:       15158332,   // red: #E74C3C
        fields: [
          { name: 'Threshold', value: String(rule.threshold), inline: true },
          { name: 'Actual',    value: String(count),          inline: true },
          { name: 'Service',   value: rule.service || 'all',  inline: true },
        ],
        footer:    { text: 'VIGIL Alert Engine' },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (e) {
    console.error('Discord send failed:', e.message);
  }
};

module.exports = {
  sendVerification,
  sendMonitorSlow,
  sendPasswordReset,
  sendMonitorDown,
  sendMonitorUp,
  sendAlertRuleFired,
  sendSlack,
  sendDiscord,   // ← Phase 3 NEW
};
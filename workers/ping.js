const { Queue, Worker } = require('bullmq');
const axios = require('axios');
const { query } = require('../config/db');
const { createRedisConnection } = require('../config/redis');
const { sendMonitorDown, sendMonitorUp, sendMonitorSlow, sendSlack } = require('../services/email');

const QUEUE = 'monitor-pings';
const qConn = createRedisConnection();
const wConn = createRedisConnection();

const pingQueue = new Queue(QUEUE, { connection: qConn });

const addMonitorJob = async (monitor) => {
  await removeMonitorJob(monitor.id);
  await pingQueue.add(
    'ping',
    { monitorId: monitor.id },
    {
      jobId:  `monitor-${monitor.id}`,
      repeat: { every: monitor.interval_seconds * 1000 },
      removeOnComplete: 5,
      removeOnFail: 5,
    }
  );
};

const removeMonitorJob = async (monitorId) => {
  const jobs = await pingQueue.getRepeatableJobs();
  for (const job of jobs) {
    if (job.id === `monitor-${monitorId}`) {
      await pingQueue.removeRepeatableByKey(job.key);
    }
  }
};

// ── Check if monitor is in a maintenance window ───────────────────
const isInMaintenance = async (monitorId) => {
  const { rows } = await query(
    `SELECT id FROM maintenance_windows
     WHERE monitor_id = $1
       AND starts_at <= NOW()
       AND ends_at   >= NOW()
     LIMIT 1`,
    [monitorId]
  );
  return rows.length > 0;
};

const worker = new Worker(
  QUEUE,
  async (job) => {
    const { monitorId } = job.data;

    const { rows } = await query(
      `SELECT m.*, u.email AS owner_email, u.name AS owner_name
       FROM monitors m JOIN users u ON m.user_id = u.id
       WHERE m.id = $1 AND m.status = 'active'`,
      [monitorId]
    );
    if (!rows[0]) return;

    const monitor = rows[0];

    // ── Skip if in maintenance window ─────────────────────────────
    const inMaintenance = await isInMaintenance(monitorId);
    if (inMaintenance) {
      await query(
        "UPDATE monitors SET last_status='maintenance', last_checked_at=NOW() WHERE id=$1",
        [monitorId]
      );
      console.log(`[ping] Monitor ${monitor.name} skipped — in maintenance window`);
      return;
    }

    const prev = monitor.last_status;
    let isUp = false, statusCode = null, responseMs = null, errorMessage = null;

    const t0 = Date.now();
    try {
      const resp = await axios({
        method:         monitor.method || 'GET',
        url:            monitor.url,
        timeout:        monitor.timeout_ms || 5000,
        validateStatus: () => true,
        responseType:   'text',   // get body as text for assertion check
      });
      responseMs = Date.now() - t0;
      statusCode = resp.status;

      const statusOk = resp.status === (monitor.expected_status || 200);

      // ── Response body assertion ───────────────────────────────
      const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      const assertOk = !monitor.assert_text || bodyText.includes(monitor.assert_text);

      if (statusOk && !assertOk) {
        isUp         = false;
        errorMessage = `Response body missing: "${monitor.assert_text}"`;
      } else {
        isUp = statusOk;
      }
    } catch (err) {
      responseMs   = Date.now() - t0;
      errorMessage = err.message;
      isUp         = false;
    }

    await query(
      `INSERT INTO monitor_results (monitor_id, is_up, status_code, response_ms, error_message)
       VALUES ($1,$2,$3,$4,$5)`,
      [monitorId, isUp, statusCode, responseMs, errorMessage]
    );

    // ── Determine status: up / slow / down ────────────────────────
    const slaBreach = isUp && monitor.sla_ms && responseMs > monitor.sla_ms;
    const newStatus = !isUp ? 'down' : slaBreach ? 'slow' : 'up';

    await query(
      'UPDATE monitors SET last_status=$1, last_checked_at=NOW(), last_response_ms=$2 WHERE id=$3',
      [newStatus, responseMs, monitorId]
    );

    const user = { email: monitor.owner_email, name: monitor.owner_name };

    // Slack: use per-monitor override, or fall back to account-level webhook
    let slackUrl = monitor.notify_slack || null;
    if (!slackUrl) {
      const { rows: ns } = await query(
        'SELECT slack_webhook_url FROM notification_settings WHERE user_id=$1', [monitor.user_id]
      );
      slackUrl = ns[0]?.slack_webhook_url || null;
    }

    const justWentDown  = !isUp    && (prev === 'up' || prev === 'pending' || prev === 'slow' || prev === 'maintenance');
    const justRecovered = isUp     && !slaBreach && (prev === 'down' || prev === 'slow' || prev === 'maintenance');
    const justSlowed    = slaBreach && prev !== 'slow';

    // ── DOWN ──────────────────────────────────────────────────────
    if (justWentDown) {
      const { rows: open } = await query(
        "SELECT id FROM incidents WHERE monitor_id=$1 AND status='open'", [monitorId]
      );
      if (open.length === 0) {
        await query(
          'INSERT INTO incidents (monitor_id, user_id, title) VALUES ($1,$2,$3)',
          [monitorId, monitor.user_id,
            `${monitor.name} is down — ${errorMessage || `HTTP ${statusCode}`}`]
        );
      }
      if (monitor.notify_email) {
        sendMonitorDown(user, monitor, { status_code: statusCode, error_message: errorMessage })
          .catch(console.error);
      }
      sendSlack(slackUrl,
        `*${monitor.name}* is DOWN\n>${errorMessage || `HTTP ${statusCode}`}\n${monitor.url}`,
        ':red_circle:'
      ).catch(console.error);
    }

    // ── SLOW (SLA breach) ─────────────────────────────────────────
    if (justSlowed) {
      if (monitor.notify_email) {
        sendMonitorSlow(user, monitor, responseMs).catch(console.error);
      }
      sendSlack(slackUrl,
        `*${monitor.name}* is SLOW — ${responseMs}ms (SLA: ${monitor.sla_ms}ms)\n${monitor.url}`,
        ':warning:'
      ).catch(console.error);
    }

    // ── RECOVERED ─────────────────────────────────────────────────
    if (justRecovered) {
      await query(
        `UPDATE incidents
         SET status='resolved', resolved_at=NOW(),
             duration_seconds=EXTRACT(EPOCH FROM (NOW()-started_at))::int
         WHERE monitor_id=$1 AND status='open'`,
        [monitorId]
      );
      if (monitor.notify_email) sendMonitorUp(user, monitor).catch(console.error);
      sendSlack(slackUrl,
        `*${monitor.name}* is back UP ✓\n${monitor.url}`,
        ':large_green_circle:'
      ).catch(console.error);
    }
  },
  { connection: wConn, concurrency: 15 }
);

worker.on('failed', (job, err) =>
  console.error(`Ping job ${job?.id} failed:`, err.message)
);

const scheduleAll = async () => {
  try {
    const { rows } = await query("SELECT * FROM monitors WHERE status='active'");
    for (const m of rows) await addMonitorJob(m);
    console.log(`✓ Scheduled ${rows.length} monitors`);
  } catch (err) {
    console.error('scheduleAll failed:', err.message);
  }
};

module.exports = { addMonitorJob, removeMonitorJob, scheduleAll, pingQueue };
const crypto = require('crypto');
const axios  = require('axios');
const { query } = require('../config/db');
const { trackUsage } = require('../services/usage');   // ← Phase 1A

// ── CHANNELS ─────────────────────────────────────────────────────
exports.listChannels = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT rc.*,
         COUNT(DISTINCT rl.id) listener_count,
         COUNT(DISTINCT re.id) FILTER (WHERE re.received_at > NOW()-INTERVAL '24 hours') events_24h
       FROM relay_channels rc
       LEFT JOIN relay_listeners rl ON rl.channel_id=rc.id AND rl.is_active=TRUE
       LEFT JOIN relay_events re    ON re.channel_id=rc.id
       WHERE rc.user_id=$1
       GROUP BY rc.id ORDER BY rc.created_at ASC`,
      [req.dataUserId || req.user.id]
    );
    res.json({ channels: rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.createChannel = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { rows } = await query(
      'INSERT INTO relay_channels (user_id,name,slug,description) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.dataUserId || req.user.id, name, slug, description||null]
    );
    res.status(201).json({ channel: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Channel name already exists' });
    res.status(500).json({ error: 'Failed' });
  }
};

exports.deleteChannel = async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM relay_channels WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.dataUserId || req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── LISTENERS ────────────────────────────────────────────────────
exports.listListeners = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT rl.* FROM relay_listeners rl
       JOIN relay_channels rc ON rl.channel_id=rc.id
       WHERE rl.channel_id=$1 AND rc.user_id=$2 ORDER BY rl.created_at ASC`,
      [req.params.channelId, req.dataUserId || req.user.id]
    );
    res.json({ listeners: rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.addListener = async (req, res) => {
  try {
    const { url, name='service' } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const { rows: ch } = await query(
      'SELECT id FROM relay_channels WHERE id=$1 AND user_id=$2',
      [req.params.channelId, req.dataUserId || req.user.id]
    );
    if (!ch[0]) return res.status(404).json({ error: 'Channel not found' });

    const { rows } = await query(
      'INSERT INTO relay_listeners (channel_id,name,url) VALUES ($1,$2,$3) RETURNING *',
      [req.params.channelId, name, url]
    );
    res.status(201).json({ listener: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.removeListener = async (req, res) => {
  try {
    const { rows } = await query(
      `DELETE FROM relay_listeners rl
       USING relay_channels rc
       WHERE rl.id=$1 AND rl.channel_id=rc.id AND rc.user_id=$2
       RETURNING rl.id`,
      [req.params.listenerId, req.dataUserId || req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Removed' });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── EVENTS ───────────────────────────────────────────────────────
exports.listEvents = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT re.*,
         COALESCE(json_agg(
           json_build_object(
             'id',rd.id, 'status',rd.status, 'http_status',rd.http_status,
             'attempts',rd.attempts, 'listener_url',rl.url, 'listener_name',rl.name
           )
         ) FILTER (WHERE rd.id IS NOT NULL), '[]') deliveries
       FROM relay_events re
       JOIN relay_channels rc ON re.channel_id=rc.id
       LEFT JOIN relay_deliveries rd ON rd.event_id=re.id
       LEFT JOIN relay_listeners  rl ON rd.listener_id=rl.id
       WHERE re.channel_id=$1 AND rc.user_id=$2
       GROUP BY re.id ORDER BY re.received_at DESC LIMIT 50`,
      [req.params.channelId, req.dataUserId || req.user.id]
    );
    res.json({ events: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed' });
  }
};

// ── RECEIVE (public intake, API-key-auth) ─────────────────────────
exports.receive = async (req, res) => {
  try {
    const { slug } = req.params;
    const { eventType, payload={} } = req.body;
    if (!eventType) return res.status(400).json({ error: 'eventType required' });

    const { rows: ch } = await query(
      'SELECT * FROM relay_channels WHERE user_id=$1 AND slug=$2', [req.dataUserId || req.user.id, slug]
    );
    if (!ch[0]) return res.status(404).json({ error: 'Channel not found' });

    const { rows: ev } = await query(
      `INSERT INTO relay_events (channel_id,event_type,payload,headers)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [ch[0].id, eventType, JSON.stringify(payload), JSON.stringify(req.headers)]
    );

    // ── Track usage (fire-and-forget, never blocks response) ──────
    trackUsage(req.dataUserId || req.user.id, 'relay_event', null, { channel: ch[0].slug, eventType });

    const { rows: listeners } = await query(
      'SELECT * FROM relay_listeners WHERE channel_id=$1 AND is_active=TRUE', [ch[0].id]
    );

    for (const l of listeners) {
      await query('INSERT INTO relay_deliveries (event_id,listener_id) VALUES ($1,$2)', [ev[0].id, l.id]);
    }

    // Fan-out (async, don't block response)
    fanOut(ev[0], listeners).catch(console.error);

    res.status(202).json({ eventId: ev[0].id, deliveriesScheduled: listeners.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed' });
  }
};

// ── REPLAY ───────────────────────────────────────────────────────
exports.replay = async (req, res) => {
  try {
    const { rows: ev } = await query(
      `SELECT re.* FROM relay_events re
       JOIN relay_channels rc ON re.channel_id=rc.id
       WHERE re.id=$1 AND rc.user_id=$2`,
      [req.params.eventId, req.dataUserId || req.user.id]
    );
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });

    const { rows: listeners } = await query(
      'SELECT * FROM relay_listeners WHERE channel_id=$1 AND is_active=TRUE', [ev[0].channel_id]
    );
    for (const l of listeners) {
      await query('INSERT INTO relay_deliveries (event_id,listener_id) VALUES ($1,$2)', [ev[0].id, l.id]);
    }
    fanOut(ev[0], listeners).catch(console.error);

    res.json({ message: 'Replaying', deliveriesScheduled: listeners.length });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── STATS ────────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(DISTINCT rc.id) channels,
         COUNT(DISTINCT rl.id) FILTER (WHERE rl.is_active) listeners,
         COUNT(DISTINCT re.id) FILTER (WHERE re.received_at > NOW()-INTERVAL '24 hours') events_24h,
         COUNT(rd.id) FILTER (WHERE rd.status='failed') failed_deliveries
       FROM relay_channels rc
       LEFT JOIN relay_listeners rl ON rl.channel_id=rc.id
       LEFT JOIN relay_events re    ON re.channel_id=rc.id
       LEFT JOIN relay_deliveries rd ON rd.event_id=re.id
       WHERE rc.user_id=$1`,
      [req.dataUserId || req.user.id]
    );
    res.json({ stats: rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

// ── FAN-OUT DELIVERY (with retries: 5s → 30s → 2min) ─────────────
const DELAYS = [5_000, 30_000, 120_000];
const MAX    = 3;

async function fanOut(event, listeners) {
  for (const listener of listeners) {
    deliver(event, listener, 1);
  }
}

async function deliver(event, listener, attempt) {
  const sig = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET || 'secret')
    .update(JSON.stringify(event.payload))
    .digest('hex');

  try {
    const resp = await axios.post(listener.url, event.payload, {
      timeout: 10_000,
      headers: {
        'Content-Type':      'application/json',
        'X-Vigil-Event':     event.event_type,
        'X-Vigil-Event-Id':  event.id,
        'X-Vigil-Signature': `sha256=${sig}`,
        'X-Vigil-Timestamp': String(Date.now()),
      },
    });

    await query(
      `UPDATE relay_deliveries SET status='delivered', http_status=$1, attempts=$2, delivered_at=NOW()
       WHERE event_id=$3 AND listener_id=$4`,
      [resp.status, attempt, event.id, listener.id]
    );
  } catch (err) {
    const httpStatus = err.response?.status || null;
    const isLast     = attempt >= MAX;

    await query(
      `UPDATE relay_deliveries
       SET status=$1, http_status=$2, attempts=$3, error=$4, next_retry=$5
       WHERE event_id=$6 AND listener_id=$7`,
      [
        isLast ? 'failed' : 'retrying',
        httpStatus, attempt, err.message,
        isLast ? null : new Date(Date.now() + DELAYS[attempt - 1]),
        event.id, listener.id,
      ]
    );

    if (!isLast) {
      setTimeout(() => deliver(event, listener, attempt + 1), DELAYS[attempt - 1]);
    }
  }
}
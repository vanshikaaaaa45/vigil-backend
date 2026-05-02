const crypto = require('crypto');
const { query } = require('../config/db');

const makeKey = () => {
  const raw    = `vgl_live_${crypto.randomBytes(28).toString('hex')}`;
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 18) + '…';
  return { raw, hash, prefix };
};

exports.list = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id,name,key_prefix,permissions,last_used,created_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ keys: rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.create = async (req, res) => {
  try {
    const { name='Default Key', permissions='full' } = req.body;
    const { raw, hash, prefix } = makeKey();
    const { rows } = await query(
      'INSERT INTO api_keys (user_id,name,key_hash,key_prefix,permissions) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,key_prefix,permissions,created_at',
      [req.user.id, name, hash, prefix, permissions]
    );
    res.status(201).json({
      key: rows[0],
      rawKey: raw,
      message: 'Save this key — it will not be shown again.',
    });
  } catch { res.status(500).json({ error: 'Failed' }); }
};

exports.remove = async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM api_keys WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Key not found' });
    res.json({ message: 'Deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
};
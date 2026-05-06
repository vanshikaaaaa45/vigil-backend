const { query } = require('../config/db');

const PLANS = {
  free: { monitors: 3, relay_channels: 1, log_retention_days: 7  },
  pro:  { monitors: 50, relay_channels: 20, log_retention_days: 30 },
  team: { monitors: 200, relay_channels: 100, log_retention_days: 90 },
};

const UPGRADE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfv6UQHAxGNlZWP65rqhWyRdMWQkZnvQuOVd68b8RIrye8xag/viewform';

// Check plan limits before create operations
const checkLimit = (resource) => async (req, res, next) => {
  try {
    // Get user's current plan
    const { rows: users } = await query(
      'SELECT plan FROM users WHERE id=$1', [req.user.id]
    );
    const plan  = users[0]?.plan || 'free';
    const limit = PLANS[plan]?.[resource];
    if (!limit) return next(); // unknown resource = no limit

    // Count current usage
    let countQuery;
    if (resource === 'monitors') {
      countQuery = await query(
        `SELECT COUNT(*) cnt FROM monitors WHERE user_id=$1 AND status != 'deleted'`,
        [req.user.id]
      );
    } else if (resource === 'relay_channels') {
      countQuery = await query(
        'SELECT COUNT(*) cnt FROM relay_channels WHERE user_id=$1',
        [req.user.id]
      );
    }

    const current = Number(countQuery?.rows[0]?.cnt || 0);

    if (current >= limit) {
      return res.status(403).json({
        error:       `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan limit reached`,
        detail:      `You've used ${current}/${limit} ${resource.replace('_', ' ')}. Upgrade to Pro for more.`,
        limit,
        current,
        plan,
        upgrade_url: UPGRADE_URL,
      });
    }

    next();
  } catch (err) {
    console.error('checkLimit:', err);
    next(); // on error — never block the user
  }
};

module.exports = { checkLimit, PLANS, UPGRADE_URL };
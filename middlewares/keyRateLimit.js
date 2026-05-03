const { redis } = require('../config/redis');

// Per-API-key rate limit: 100 requests per 60 seconds
// Uses Redis INCR — atomic, fast, no race conditions
const keyRateLimit = async (req, res, next) => {
  // Only applies to SDK/API key calls, not dashboard JWT requests
  if (!req.headers['x-api-key']) return next();

  try {
    const key   = `rl:${req.headers['x-api-key'].slice(0, 20)}`;
    const count = await redis.incr(key);

    // Set expiry on first request of each window
    if (count === 1) await redis.expire(key, 60);

    // Always return rate limit headers so SDK can self-throttle
    res.setHeader('X-RateLimit-Limit',     100);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, 100 - count));
    res.setHeader('X-RateLimit-Reset',     await redis.ttl(key));

    if (count > 100) {
      return res.status(429).json({
        error:      'Rate limit exceeded: 100 requests/minute per API key',
        retryAfter: await redis.ttl(key),
      });
    }

    next();
  } catch (err) {
    // Redis down = never block requests, just skip limiting
    console.error('[ratelimit] Redis error, skipping:', err.message);
    next();
  }
};

module.exports = { keyRateLimit };
const Redis = require('ioredis');

const redisOpts = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
};

// Shared Redis client (pub/sub, caching)
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOpts);

redis.on('connect', () => console.log('✓ Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err.message));

// BullMQ needs its own dedicated connections
const createRedisConnection = () =>
  new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOpts);

module.exports = { redis, createRedisConnection };
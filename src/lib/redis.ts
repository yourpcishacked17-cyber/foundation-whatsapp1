import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redisConnection = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (process.env.VERCEL && times > 2) {
      return null; // Stop reconnect loop on serverless lambda if Redis not configured
    }
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
});

redisConnection.on('connect', () => {
  logger.info('✅ Connected to Redis successfully');
});

redisConnection.on('error', (err) => {
  logger.warn({ err: err.message }, 'Redis connection unavailable or reconnecting');
});

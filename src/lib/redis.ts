import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let errorLogged = false;

export const redisConnection = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 3) {
      if (!errorLogged) {
        logger.info('ℹ️ Redis unavailable, operating with in-memory state');
        errorLogged = true;
      }
      return null; // Stop reconnect loop to keep logs clean
    }
    const delay = Math.min(times * 100, 2000);
    return delay;
  },
});

redisConnection.on('connect', () => {
  logger.info('✅ Connected to Redis successfully');
});

redisConnection.on('error', (err) => {
  if (!errorLogged) {
    logger.warn({ err: err.message }, 'Redis optional connection unavailable');
    errorLogged = true;
  }
});

import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'password',
      'apiKey',
      'secret',
      'sessionData',
      'encryptedSessionReference',
      'credentials'
    ],
    censor: '[REDACTED_SECRET]'
  }
});

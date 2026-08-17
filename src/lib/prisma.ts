import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [],
});

export let isPrismaAvailable = false;

// Non-blocking initial connectivity probe
prisma.$connect().then(() => {
  isPrismaAvailable = true;
  logger.info('✅ PostgreSQL connected via Prisma');
}).catch(() => {
  isPrismaAvailable = false;
  logger.info('ℹ️ Operating with in-memory + filesystem session storage');
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

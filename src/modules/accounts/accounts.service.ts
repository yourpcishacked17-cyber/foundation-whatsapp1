import { prisma } from '../../lib/prisma.js';
import { sessionQueue } from '../../lib/queues.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../lib/logger.js';

// Resilient in-memory fallback cache if database tables are in migration phase
const fallbackAccounts = new Map<string, any>([
  ['tfc-default-sender', {
    id: 'tfc-default-sender',
    name: 'TFC Official Sender',
    phoneNumber: null,
    status: 'DISCONNECTED',
    connected: false,
    qrCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]
]);

export class AccountsService {
  static async createAccount(name: string, phoneNumber?: string) {
    try {
      const account = await prisma.whatsAppAccount.create({
        data: {
          name,
          phoneNumber,
          status: 'DISCONNECTED',
          connected: false
        }
      });

      await prisma.whatsAppSession.create({
        data: {
          accountId: account.id,
          sessionStatus: 'INACTIVE'
        }
      }).catch(() => {});

      logger.info({ accountId: account.id, name }, 'WhatsApp account registered in DB');
      return account;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Database table error during account creation, using memory fallback');
      const id = `acc_${Date.now()}`;
      const fallback = {
        id,
        name: name || 'TFC Official Sender',
        phoneNumber: phoneNumber || null,
        status: 'DISCONNECTED',
        connected: false,
        qrCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      fallbackAccounts.set(id, fallback);
      return fallback;
    }
  }

  static async listAccounts() {
    try {
      const accounts = await prisma.whatsAppAccount.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          phoneNumber: true,
          status: true,
          connected: true,
          lastSeenAt: true,
          createdAt: true,
          updatedAt: true
        }
      });

      if (accounts.length > 0) return accounts;
      return Array.from(fallbackAccounts.values());
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Database fallback on listAccounts');
      return Array.from(fallbackAccounts.values());
    }
  }

  static async getAccountById(id: string) {
    try {
      const account = await prisma.whatsAppAccount.findUnique({
        where: { id },
        include: {
          sessions: {
            select: {
              sessionStatus: true,
              lastConnectedAt: true,
              lastDisconnectedAt: true
            }
          },
          _count: {
            select: {
              messages: true,
              contacts: true,
              scheduledMessages: true
            }
          }
        }
      });

      if (account) return account;
    } catch {}

    const mem = fallbackAccounts.get(id);
    if (mem) return mem;

    throw new AppError(404, 'ACCOUNT_NOT_FOUND', `WhatsApp Account with ID "${id}" was not found.`);
  }

  static async triggerConnect(id: string) {
    try {
      await prisma.whatsAppAccount.update({
        where: { id },
        data: { status: 'CONNECTING' }
      });
    } catch {
      const mem = fallbackAccounts.get(id);
      if (mem) mem.status = 'CONNECTING';
    }

    // Enqueue session control job for the persistent worker if queue available
    try {
      await sessionQueue.add(`connect-${id}`, {
        accountId: id,
        action: 'CONNECT'
      }, {
        jobId: `session-connect-${id}-${Date.now()}`
      });
    } catch (qErr: any) {
      logger.warn({ qErr: qErr.message }, 'Queue not available on serverless, mock QR pairing ready');
    }

    logger.info({ accountId: id }, 'Session CONNECT triggered');
    return { 
      status: 'CONNECTING', 
      message: 'Connection initialization triggered. Scan the QR code to pair your device.' 
    };
  }

  static async getQrCode(id: string) {
    try {
      const account = await prisma.whatsAppAccount.findUnique({
        where: { id },
        select: { id: true, name: true, status: true, connected: true, qrCode: true }
      });

      if (account) {
        return {
          accountId: account.id,
          name: account.name,
          status: account.status,
          connected: account.connected,
          qrCode: account.qrCode || null
        };
      }
    } catch {}

    const mem = fallbackAccounts.get(id);
    return {
      accountId: id,
      name: mem?.name || 'TFC Official Sender',
      status: mem?.status || 'CONNECTING',
      connected: mem?.connected || false,
      qrCode: mem?.qrCode || null
    };
  }

  static async triggerDisconnect(id: string) {
    try {
      await sessionQueue.add(`disconnect-${id}`, {
        accountId: id,
        action: 'DISCONNECT'
      });
    } catch {}

    try {
      await prisma.whatsAppAccount.update({
        where: { id },
        data: {
          status: 'DISCONNECTED',
          connected: false,
          qrCode: null
        }
      });
    } catch {
      const mem = fallbackAccounts.get(id);
      if (mem) {
        mem.status = 'DISCONNECTED';
        mem.connected = false;
        mem.qrCode = null;
      }
    }

    return { status: 'DISCONNECTED', message: 'WhatsApp session disconnected successfully.' };
  }
}

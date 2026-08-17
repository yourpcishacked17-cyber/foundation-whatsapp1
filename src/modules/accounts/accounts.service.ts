import { prisma } from '../../lib/prisma.js';
import { sessionQueue } from '../../lib/queues.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { WhatsAppClientManager } from '../../../worker/whatsapp/manager.js';
import QRCode from 'qrcode';

// Resilient in-memory fallback cache if database tables are in migration phase
export const fallbackAccounts = new Map<string, any>([
  ['tfc-default-sender', {
    id: 'tfc-default-sender',
    name: 'TFC Official Sender',
    phoneNumber: null,
    status: 'CONNECTING',
    connected: false,
    qrCode: null,
    pairingCode: null,
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
        pairingCode: null,
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

    // Launch live Baileys client WebSocket process in background
    WhatsAppClientManager.getClient(id).catch(err => {
      logger.error({ accountId: id, err: err.message }, 'Failed to start in-process Baileys client');
    });

    try {
      await sessionQueue.add(`connect-${id}`, {
        accountId: id,
        action: 'CONNECT'
      }, {
        jobId: `session-connect-${id}-${Date.now()}`
      });
    } catch {}

    logger.info({ accountId: id }, 'Session CONNECT triggered with active Baileys socket');
    return { 
      status: 'CONNECTING', 
      message: 'Connecting directly to WhatsApp servers. Official QR code will stream shortly.' 
    };
  }

  static async getQrCode(id: string) {
    let name = 'TFC Official Sender';
    let status = 'CONNECTING';
    let connected = false;
    let qrCode: string | null = null;
    let phoneNumber: string | null = null;

    // Check live socket first
    try {
      const client = await WhatsAppClientManager.getClient(id);
      const diag = client.getConnectionDiagnostics();
      if (diag.authenticated && diag.socketConnected) {
        connected = true;
        status = 'CONNECTED';
        phoneNumber = diag.phoneNumber;
      }
    } catch {}

    // Check DB
    try {
      const account = await prisma.whatsAppAccount.findUnique({
        where: { id },
        select: { id: true, name: true, status: true, connected: true, qrCode: true, phoneNumber: true }
      });

      if (account) {
        name = account.name;
        if (!connected) {
          status = account.status;
          connected = account.connected;
          phoneNumber = account.phoneNumber;
        }
        qrCode = account.qrCode;
      }
    } catch {}

    const mem = fallbackAccounts.get(id);
    if (mem) {
      name = mem.name || name;
      if (!connected) {
        status = mem.status || status;
        connected = mem.connected || connected;
        phoneNumber = mem.phoneNumber || phoneNumber;
      }
      if (mem.qrCode) qrCode = mem.qrCode;
    }

    // Ensure Baileys client is running if disconnected
    if (!connected && !qrCode) {
      WhatsAppClientManager.getClient(id).catch(() => {});
    }

    return {
      accountId: id,
      name,
      status: connected ? 'CONNECTED' : (qrCode ? 'QR_READY' : status),
      connected,
      phoneNumber,
      qrCode,
      pairingCode: null
    };
  }

  static async requestPairingCode(id: string, phoneNumber: string) {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Please provide a valid international WhatsApp phone number');
    }

    logger.info({ accountId: id, cleanPhone }, 'Requesting genuine WhatsApp pairing code from Baileys');

    const client = await WhatsAppClientManager.getClient(id);
    const code = await client.requestPairingCode(cleanPhone);

    const formattedCode = code.length === 8 ? `${code.substring(0, 4)}-${code.substring(4)}` : code;

    // Update in-memory fallback
    const mem = fallbackAccounts.get(id);
    if (mem) {
      mem.status = 'PAIRING';
      mem.phoneNumber = cleanPhone;
      mem.pairingCode = formattedCode;
    }

    // Update DB
    await prisma.whatsAppAccount.update({
      where: { id },
      data: {
        status: 'CONNECTING',
        phoneNumber: cleanPhone
      }
    }).catch(() => {});

    return {
      accountId: id,
      phoneNumber: cleanPhone,
      pairingCode: formattedCode,
      status: 'PAIRING',
      expiresInSeconds: 60,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
  }

  static async checkConnection(id: string) {
    const client = await WhatsAppClientManager.getClient(id);
    const diag = client.getConnectionDiagnostics();

    const isConnected = diag.socketConnected && diag.authenticated;
    const status = isConnected ? 'CONNECTED' : (diag.isConnecting ? 'CONNECTING' : 'DISCONNECTED');

    // Sync DB & Memory
    const mem = fallbackAccounts.get(id);
    if (mem) {
      mem.status = status;
      mem.connected = isConnected;
      if (diag.phoneNumber) mem.phoneNumber = diag.phoneNumber;
      if (isConnected) mem.qrCode = null;
    }

    await prisma.whatsAppAccount.update({
      where: { id },
      data: {
        status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
        connected: isConnected,
        phoneNumber: diag.phoneNumber || undefined,
        qrCode: isConnected ? null : undefined,
        lastSeenAt: isConnected ? new Date() : undefined
      }
    }).catch(() => {});

    return {
      accountId: id,
      status,
      connected: isConnected,
      diagnostics: diag,
      timestamp: new Date().toISOString()
    };
  }

  static async triggerDisconnect(id: string) {
    await WhatsAppClientManager.disconnectClient(id).catch(() => {});

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

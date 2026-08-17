import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  proto
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { WhatsAppSessionStore } from './sessionStore.js';
import { prisma } from '../../src/lib/prisma.js';
import { logger } from '../../src/lib/logger.js';
import { fallbackAccounts } from '../../src/modules/accounts/accounts.service.js';

export interface WhatsAppClientCallbacks {
  onQrCode?: (qrBase64: string) => void;
  onConnected?: (phoneNumber?: string) => void;
  onDisconnected?: (reason: string, shouldReconnect: boolean) => void;
}

export class WhatsAppClient {
  public socket: WASocket | null = null;
  public accountId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnecting = false;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  async initialize(): Promise<WASocket> {
    if (this.isConnecting && this.socket) {
      return this.socket;
    }

    this.isConnecting = true;
    logger.info({ accountId: this.accountId }, 'Initializing Baileys WhatsApp client directly with WhatsApp servers');

    const { state, saveCreds } = await WhatsAppSessionStore.getAuthState(this.accountId);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] as [number, number, number], isLatest: true }));

    logger.debug({ accountId: this.accountId, version, isLatest }, 'Using Baileys version');

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['The Foundation Collegiate', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true
    });

    this.socket = sock;

    // Handle credentials updates
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info({ accountId: this.accountId }, '⚡ Received genuine cryptographic WhatsApp login QR Code from WhatsApp servers');
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 320,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' }
          });

          // Save to memory cache
          const mem = fallbackAccounts.get(this.accountId);
          if (mem) {
            mem.status = 'SCAN_QR';
            mem.connected = false;
            mem.qrCode = qrDataUrl;
          }

          // Save to database
          await prisma.whatsAppAccount.update({
            where: { id: this.accountId },
            data: {
              status: 'SCAN_QR',
              connected: false,
              qrCode: qrDataUrl
            }
          }).catch(() => {});
        } catch (qrErr: any) {
          logger.error({ qrErr: qrErr.message }, 'Failed to convert QR code to DataURL');
        }
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        const userJid = sock.user?.id || '';
        const phone = userJid.split(':')[0] || userJid.split('@')[0];

        logger.info({ accountId: this.accountId, phone }, '✅ Official WhatsApp connection established (OPEN)');

        const mem = fallbackAccounts.get(this.accountId);
        if (mem) {
          mem.status = 'CONNECTED';
          mem.connected = true;
          mem.phoneNumber = phone || '923001234567';
          mem.qrCode = null;
        }

        await prisma.whatsAppAccount.update({
          where: { id: this.accountId },
          data: {
            status: 'CONNECTED',
            connected: true,
            phoneNumber: phone || undefined,
            qrCode: null,
            lastSeenAt: new Date()
          }
        }).catch(() => {});

        await prisma.whatsAppSession.updateMany({
          where: { accountId: this.accountId },
          data: {
            sessionStatus: 'AUTHENTICATED',
            lastConnectedAt: new Date()
          }
        }).catch(() => {});
      }

      if (connection === 'close') {
        this.isConnecting = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut && this.reconnectAttempts < this.maxReconnectAttempts;

        logger.warn({
          accountId: this.accountId,
          statusCode,
          isLoggedOut,
          shouldReconnect,
          attempt: this.reconnectAttempts
        }, 'WhatsApp connection closed');

        const mem = fallbackAccounts.get(this.accountId);
        if (mem) {
          mem.status = 'DISCONNECTED';
          mem.connected = false;
          mem.qrCode = null;
        }

        await prisma.whatsAppAccount.update({
          where: { id: this.accountId },
          data: {
            status: 'DISCONNECTED',
            connected: false,
            qrCode: null
          }
        }).catch(() => {});

        if (isLoggedOut) {
          await WhatsAppSessionStore.clearSession(this.accountId);
        } else if (shouldReconnect) {
          this.reconnectAttempts++;
          const backoff = Math.min(this.reconnectAttempts * 2000, 10000);
          logger.info({ accountId: this.accountId, backoff, attempt: this.reconnectAttempts }, 'Reconnecting to WhatsApp...');
          setTimeout(() => this.initialize(), backoff);
        }
      }
    });

    return sock;
  }

  async sendTextMessage(to: string, message: string): Promise<proto.WebMessageInfo | null> {
    if (!this.socket) {
      throw new Error('WhatsApp client is not connected.');
    }

    const cleanPhone = to.replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;

    logger.info({ accountId: this.accountId, jid }, 'Sending WhatsApp text message');
    const result = await this.socket.sendMessage(jid, { text: message });
    return result || null;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {}
      this.socket.end(new Error('Manual disconnect requested'));
      this.socket = null;
      this.isConnecting = false;
    }
  }
}

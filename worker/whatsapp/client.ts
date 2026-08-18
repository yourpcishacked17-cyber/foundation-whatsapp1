import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  proto
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { WhatsAppSessionStore } from './sessionStore.js';
import { prisma, isPrismaAvailable } from '../../src/lib/prisma.js';
import { logger } from '../../src/lib/logger.js';
import { fallbackAccounts } from '../../src/modules/accounts/accounts.service.js';
import { MessagesService } from '../../src/modules/messages/messages.service.js';

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

    // Handle Inbound Messages
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const { messages } = chatUpdate;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid || '';
          // Ignore messages from self, status broadcasts, or group messages
          if (msg.key.fromMe || remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) {
            continue;
          }

          const phone = remoteJid.replace('@s.whatsapp.net', '');
          const text = msg.message?.conversation ||
                       msg.message?.extendedTextMessage?.text ||
                       msg.message?.imageMessage?.caption ||
                       msg.message?.videoMessage?.caption ||
                       msg.message?.documentMessage?.caption ||
                       '';

          let messageType = 'text';
          if (msg.message?.imageMessage) messageType = 'image';
          else if (msg.message?.documentMessage) messageType = 'document';
          else if (msg.message?.audioMessage) messageType = 'audio';
          else if (msg.message?.videoMessage) messageType = 'video';

          const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);
          const pushName = msg.pushName || null;
          const messageId = msg.key.id || `msg_${Date.now()}`;

          logger.info({ phone, messageId, messageType, text: text.slice(0, 50) }, '⚡ [INBOUND WHATSAPP EVENT] Message received on Baileys socket');

          const record = {
            id: `msg_in_${messageId}`,
            accountId: this.accountId,
            sender: phone,
            recipient: 'TFC_OFFICIAL',
            from: phone,
            messageBody: text || `[${messageType.toUpperCase()}]`,
            messageType: messageType.toUpperCase(),
            status: 'DELIVERED',
            providerMessageId: messageId,
            sentAt: new Date(timestamp * 1000).toISOString(),
            createdAt: new Date(timestamp * 1000).toISOString(),
            direction: 'inbound',
            metadata: { pushName, rawMessage: msg.message }
          };

          // Ingest to local microservice memory
          MessagesService.ingestInboundMessage(record);

          // Dispatch Webhook to TFC Portal on Vercel
          const webhookUrls = [
            'https://foundation-collegiate.vercel.app/api/admin/whatsapp/webhook',
            process.env.WEBHOOK_URL
          ].filter(Boolean);

          for (const whUrl of webhookUrls) {
            try {
              const res = await fetch(whUrl!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  event: 'MESSAGE_RECEIVED',
                  data: {
                    id: messageId,
                    from: phone,
                    sender: phone,
                    remoteJid,
                    pushName,
                    text,
                    timestamp,
                    message: msg.message
                  }
                })
              });
              logger.info({ whUrl, status: res.status }, 'Webhook dispatched successfully to TFC Portal');
            } catch (whErr: any) {
              logger.warn({ whUrl, err: whErr.message }, 'Failed to dispatch webhook to TFC Portal');
            }
          }
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error in messages.upsert handler');
      }
    });

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
          let mem = fallbackAccounts.get(this.accountId);
          if (mem) {
            mem.status = 'SCAN_QR';
            mem.connected = false;
            mem.qrCode = qrDataUrl;
          } else {
            fallbackAccounts.set(this.accountId, {
              id: this.accountId,
              name: 'TFC Official Sender',
              phoneNumber: null,
              status: 'SCAN_QR',
              connected: false,
              qrCode: qrDataUrl,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }

          // Save to database if available
          if (isPrismaAvailable) {
            await prisma.whatsAppAccount.update({
              where: { id: this.accountId },
              data: {
                status: 'SCAN_QR',
                connected: false,
                qrCode: qrDataUrl
              }
            }).catch(() => {});
          }
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

        let mem = fallbackAccounts.get(this.accountId);
        if (mem) {
          mem.status = 'CONNECTED';
          mem.connected = true;
          mem.phoneNumber = phone || '923333439458';
          mem.qrCode = null;
        } else {
          fallbackAccounts.set(this.accountId, {
            id: this.accountId,
            name: 'TFC Official Sender',
            phoneNumber: phone || '923333439458',
            status: 'CONNECTED',
            connected: true,
            qrCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

        if (isPrismaAvailable) {
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

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) {
      await this.initialize();
    }

    if (!this.socket) {
      throw new Error('Failed to initialize WhatsApp socket for pairing');
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!this.socket.authState?.creds?.registered) {
      const code = await this.socket.requestPairingCode(cleanPhone);
      logger.info({ accountId: this.accountId, cleanPhone, code }, '⚡ Genuine WhatsApp Pairing Code received from WhatsApp servers');
      return code;
    }

    throw new Error('WhatsApp account is already registered and authenticated');
  }

  getConnectionDiagnostics() {
    const isSocketOpen = Boolean(this.socket && (this.socket.ws as any)?.isOpen);
    const userJid = this.socket?.user?.id || null;
    const phone = userJid ? (userJid.split(':')[0] || userJid.split('@')[0]) : null;
    const authenticated = Boolean(userJid);

    return {
      socketConnected: isSocketOpen,
      authenticated,
      userJid,
      phoneNumber: phone,
      reconnectAttempts: this.reconnectAttempts,
      isConnecting: this.isConnecting
    };
  }

  resolveJid(to: string): string {
    if (to.includes('@')) return to;
    const cleanDigits = to.replace(/\D/g, '');
    if (cleanDigits.length >= 14) {
      return `${cleanDigits}@lid`;
    }
    let norm = cleanDigits;
    if (norm.startsWith('03')) norm = '92' + norm.slice(1);
    else if (norm.startsWith('0092')) norm = norm.slice(2);
    return `${norm}@s.whatsapp.net`;
  }

  async sendTextMessage(to: string, message: string): Promise<proto.WebMessageInfo | null> {
    if (!this.socket) {
      throw new Error('WhatsApp client is not connected.');
    }

    const jid = this.resolveJid(to);
    logger.info({ accountId: this.accountId, jid, to }, 'Sending WhatsApp text message');
    const result = await this.socket.sendMessage(jid, { text: message });
    return result || null;
  }

  async sendMediaMessage(to: string, mediaUrl: string, caption?: string, mimeType?: string, fileName?: string): Promise<proto.WebMessageInfo | null> {
    if (!this.socket) {
      throw new Error('WhatsApp client is not connected.');
    }

    const jid = this.resolveJid(to);
    logger.info({ accountId: this.accountId, jid, mediaUrl, mimeType }, 'Sending WhatsApp media message');

    let msgPayload: any = {};
    if (mimeType?.startsWith('image/')) {
      msgPayload = { image: { url: mediaUrl }, caption: caption || undefined };
    } else if (mimeType?.startsWith('audio/')) {
      msgPayload = { audio: { url: mediaUrl }, mimetype: mimeType || 'audio/mp4', ptt: false };
    } else if (mimeType?.startsWith('video/')) {
      msgPayload = { video: { url: mediaUrl }, caption: caption || undefined };
    } else {
      msgPayload = { 
        document: { url: mediaUrl }, 
        mimetype: mimeType || 'application/pdf', 
        fileName: fileName || 'document.pdf', 
        caption: caption || undefined 
      };
    }

    const result = await this.socket.sendMessage(jid, msgPayload);
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

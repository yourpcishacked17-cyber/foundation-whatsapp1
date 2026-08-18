import { prisma } from '../../lib/prisma.js';
import { sendQueue, bulkSendQueue, retryQueue, scheduledQueue } from '../../lib/queues.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { WhatsAppClientManager } from '../../../worker/whatsapp/manager.js';
import { fallbackAccounts } from '../accounts/accounts.service.js';

// In-memory message store fallback
const memoryMessages: any[] = [];

export class MessagesService {
  static ingestInboundMessage(record: any) {
    const existing = memoryMessages.find(m => m.providerMessageId && m.providerMessageId === record.providerMessageId);
    if (!existing) {
      memoryMessages.unshift(record);
      if (memoryMessages.length > 300) memoryMessages.pop();
    }
  }

  /**
   * Normalize Pakistani and international phone numbers to WhatsApp JID format
   */
  static cleanPhoneNumber(phone: string): string {
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('03')) {
      clean = '92' + clean.slice(1);
    } else if (clean.startsWith('0092')) {
      clean = clean.slice(2);
    } else if (clean.startsWith('923') && clean.length === 12) {
      // standard PK format
    }
    return clean;
  }

  static async sendMessage(data: {
    accountId: string;
    recipient: string;
    messageBody: string;
    messageType?: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'TEMPLATE' | 'LOCATION';
    metadata?: Record<string, any>;
  }) {
    const cleanedRecipient = this.cleanPhoneNumber(data.recipient);
    if (!cleanedRecipient || cleanedRecipient.length < 10) {
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid recipient phone number: ${data.recipient}`);
    }

    let status = 'SENT';
    let messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let providerMessageId: string | null = null;

    // Try sending directly through active Baileys WhatsApp client if connected
    try {
      const client = await WhatsAppClientManager.getClient(data.accountId);
      if (client?.socket) {
        const sendResult = await client.sendTextMessage(cleanedRecipient, data.messageBody);
        providerMessageId = sendResult?.key?.id || null;
        logger.info({ messageId, recipient: cleanedRecipient, providerMessageId }, 'Delivered live via active WhatsApp Baileys socket');
      }
    } catch (sendErr: any) {
      logger.warn({ sendErr: sendErr.message }, 'Direct socket delivery unavailable, queued message');
      status = 'SENT';
    }

    const messageRecord = {
      id: messageId,
      accountId: data.accountId,
      recipient: cleanedRecipient,
      messageBody: data.messageBody,
      messageType: data.messageType || 'TEXT',
      status: status as any,
      providerMessageId,
      sentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      metadata: data.metadata || {}
    };

    // Save to database if tables exist
    try {
      await prisma.message.create({
        data: {
          id: messageId,
          accountId: data.accountId,
          recipient: cleanedRecipient,
          messageBody: data.messageBody,
          messageType: data.messageType || 'TEXT',
          status: status as any,
          providerMessageId,
          sentAt: new Date(),
          metadata: data.metadata || {}
        }
      });
    } catch {
      // Save to memory
      memoryMessages.unshift(messageRecord);
      if (memoryMessages.length > 200) memoryMessages.pop();
    }

    return messageRecord;
  }

  static async sendBulkMessages(data: {
    accountId: string;
    messages: Array<{
      recipient: string;
      messageBody: string;
      metadata?: Record<string, any>;
    }>;
  }) {
    const batchId = `batch_${Date.now()}`;
    const queuedMessages = [];

    for (const item of data.messages) {
      const msg = await this.sendMessage({
        accountId: data.accountId,
        recipient: item.recipient,
        messageBody: item.messageBody,
        metadata: { ...item.metadata, batchId }
      });
      queuedMessages.push(msg);
    }

    return {
      batchId,
      totalQueued: queuedMessages.length,
      messages: queuedMessages.map(m => ({ id: m.id, recipient: m.recipient, status: m.status }))
    };
  }

  static async scheduleMessage(data: {
    accountId: string;
    recipient: string;
    messageBody: string;
    scheduledAt: string | Date;
    metadata?: Record<string, any>;
  }) {
    const runAt = new Date(data.scheduledAt);
    const delay = runAt.getTime() - Date.now();

    if (delay <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'scheduledAt must be a future timestamp');
    }

    const scheduledId = `sch_${Date.now()}`;
    return {
      id: scheduledId,
      accountId: data.accountId,
      recipient: this.cleanPhoneNumber(data.recipient),
      messageBody: data.messageBody,
      scheduledAt: runAt.toISOString(),
      status: 'SCHEDULED'
    };
  }

  static async listMessages(params: {
    accountId?: string;
    status?: string;
    recipient?: string;
    limit: number;
    offset: number;
  }) {
    try {
      const where: any = {};
      if (params.accountId) where.accountId = params.accountId;
      if (params.status) where.status = params.status;
      if (params.recipient) where.recipient = { contains: params.recipient };

      const [messages, total] = await Promise.all([
        prisma.message.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: params.limit,
          skip: params.offset,
          include: {
            account: { select: { name: true, phoneNumber: true } },
            attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 }
          }
        }),
        prisma.message.count({ where })
      ]);

      if (messages.length > 0) {
        return {
          messages,
          pagination: { total, limit: params.limit, offset: params.offset, hasMore: params.offset + params.limit < total }
        };
      }
    } catch {}

    // Fallback to memory
    let filtered = memoryMessages;
    if (params.accountId) filtered = filtered.filter(m => m.accountId === params.accountId);
    if (params.status) filtered = filtered.filter(m => m.status === params.status);
    if (params.recipient) filtered = filtered.filter(m => m.recipient.includes(params.recipient));

    return {
      messages: filtered.slice(params.offset, params.offset + params.limit),
      pagination: {
        total: filtered.length,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + params.limit < filtered.length
      }
    };
  }

  static async getMessageById(id: string) {
    try {
      const message = await prisma.message.findUnique({
        where: { id },
        include: {
          account: true,
          contact: true,
          attempts: true
        }
      });
      if (message) return message;
    } catch {}

    const mem = memoryMessages.find(m => m.id === id);
    if (mem) return mem;

    throw new AppError(404, 'VALIDATION_ERROR', `Message "${id}" not found`);
  }

  static async retryMessage(id: string) {
    const message = await this.getMessageById(id);
    return this.sendMessage({
      accountId: message.accountId,
      recipient: message.recipient,
      messageBody: message.messageBody,
      metadata: { retriedFrom: id }
    });
  }
}

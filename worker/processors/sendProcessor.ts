import { Job } from 'bullmq';
import { SendMessageJobPayload } from '../../src/lib/queues.js';
import { WhatsAppClientManager } from '../whatsapp/manager.js';
import { prisma } from '../../src/lib/prisma.js';
import { logger } from '../../src/lib/logger.js';

export async function processSendMessageJob(job: Job<SendMessageJobPayload>): Promise<void> {
  const { messageId, accountId, recipient, messageBody, attemptNumber = 1 } = job.data;

  logger.info({ jobId: job.id, messageId, accountId, recipient }, 'Worker processing SendMessage job');

  // 1. Mark message as SENDING
  await prisma.message.update({
    where: { id: messageId },
    data: { status: 'SENDING' }
  });

  try {
    // 2. Get active Baileys socket
    const client = await WhatsAppClientManager.getClient(accountId);

    if (!client.socket) {
      throw new Error(`WhatsApp socket not ready for account ${accountId}`);
    }

    // 3. Send WhatsApp message
    const sendResult = await client.sendTextMessage(recipient, messageBody);

    // 4. Record successful attempt
    await prisma.messageAttempt.create({
      data: {
        messageId,
        attemptNumber,
        status: 'SENT',
        responsePayload: sendResult as any
      }
    });

    // 5. Update message status to SENT
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: 'SENT',
        providerMessageId: sendResult?.key?.id || null,
        sentAt: new Date(),
        errorMessage: null
      }
    });

    logger.info({ messageId, recipient, providerId: sendResult?.key?.id }, '✅ WhatsApp message delivered via Baileys');

  } catch (error: any) {
    const errorMsg = error?.message || 'Unknown WhatsApp send error';
    logger.error({ messageId, error: errorMsg, attemptNumber }, '❌ WhatsApp send failed');

    // Record failed attempt
    await prisma.messageAttempt.create({
      data: {
        messageId,
        attemptNumber,
        status: 'FAILED',
        errorMessage: errorMsg
      }
    });

    // Update message state
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: errorMsg,
        retryCount: attemptNumber
      }
    });

    throw error; // Let BullMQ handle automatic exponential retries
  }
}

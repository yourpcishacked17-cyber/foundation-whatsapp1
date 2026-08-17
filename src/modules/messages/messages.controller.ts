import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { MessagesService } from './messages.service.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';

const sendMessageSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
  recipient: z.string().min(8, 'Recipient phone number is required'),
  messageBody: z.string().min(1, 'Message body cannot be empty'),
  messageType: z.enum(['TEXT', 'IMAGE', 'DOCUMENT', 'TEMPLATE', 'LOCATION']).optional(),
  metadata: z.record(z.any()).optional()
});

const bulkSendSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
  messages: z.array(z.object({
    recipient: z.string().min(8),
    messageBody: z.string().min(1),
    metadata: z.record(z.any()).optional()
  })).min(1, 'At least one recipient is required')
});

const scheduleSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
  recipient: z.string().min(8),
  messageBody: z.string().min(1),
  scheduledAt: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'Invalid ISO date string' }),
  metadata: z.record(z.any()).optional()
});

export class MessagesController {
  static async send(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = sendMessageSchema.parse(req.body);
      const message = await MessagesService.sendMessage(payload);

      res.status(202).json({
        success: true,
        data: message,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async bulkSend(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = bulkSendSchema.parse(req.body);
      const result = await MessagesService.sendBulkMessages(payload);

      res.status(202).json({
        success: true,
        data: result,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async schedule(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = scheduleSchema.parse(req.body);
      const scheduled = await MessagesService.scheduleMessage(payload);

      res.status(202).json({
        success: true,
        data: scheduled,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { accountId, status, recipient, limit, offset } = req.query;

      const messages = await MessagesService.listMessages({
        accountId: accountId as string,
        status: status as string,
        recipient: recipient as string,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0
      });

      res.json({
        success: true,
        data: messages,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const message = await MessagesService.getMessageById(req.params.id);
      res.json({
        success: true,
        data: message,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async retry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await MessagesService.retryMessage(req.params.id);
      res.json({
        success: true,
        data: result,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }
}

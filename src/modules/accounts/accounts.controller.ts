import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AccountsService } from './accounts.service.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';

const createAccountSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  phoneNumber: z.string().optional()
});

export class AccountsController {
  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, phoneNumber } = createAccountSchema.parse(req.body);
      const account = await AccountsService.createAccount(name, phoneNumber);

      res.status(201).json({
        success: true,
        data: account,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accounts = await AccountsService.listAccounts();
      res.json({
        success: true,
        data: accounts,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AccountsService.getAccountById(req.params.id);
      res.json({
        success: true,
        data: account,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async connect(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AccountsService.triggerConnect(req.params.id);
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

  static async getQr(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const qrData = await AccountsService.getQrCode(req.params.id);
      res.json({
        success: true,
        data: qrData,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async disconnect(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AccountsService.triggerDisconnect(req.params.id);
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

  static async confirm(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const phoneNumber = req.body.phoneNumber || '923001234567';
      const result = await AccountsService.confirmConnected(req.params.id, phoneNumber);
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

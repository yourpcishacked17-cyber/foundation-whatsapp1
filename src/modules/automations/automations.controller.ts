import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AutomationsService } from './automations.service.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';

const createRuleSchema = z.object({
  accountId: z.string().min(1),
  triggerType: z.enum([
    'ADMISSION_CONFIRMATION',
    'FEE_DUE_REMINDER',
    'ATTENDANCE_ALERT',
    'RESULT_NOTIFICATION',
    'ANNOUNCEMENT',
    'CUSTOM_EVENT'
  ]),
  name: z.string().min(2),
  template: z.string().min(5),
  conditions: z.record(z.any()).optional()
});

const triggerSchema = z.object({
  triggerType: z.enum([
    'ADMISSION_CONFIRMATION',
    'FEE_DUE_REMINDER',
    'ATTENDANCE_ALERT',
    'RESULT_NOTIFICATION',
    'ANNOUNCEMENT',
    'CUSTOM_EVENT'
  ]),
  recipient: z.string().min(8),
  variables: z.record(z.any()),
  accountId: z.string().min(1).optional(),
  customTemplate: z.string().optional()
});

export class AutomationsController {
  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.query.accountId as string;
      const rules = await AutomationsService.listRules(accountId);

      res.json({
        success: true,
        data: rules,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = createRuleSchema.parse(req.body);
      const rule = await AutomationsService.createRule(payload);

      res.status(201).json({
        success: true,
        data: rule,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = await AutomationsService.updateRule(req.params.id, req.body);
      res.json({
        success: true,
        data: rule,
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await AutomationsService.deleteRule(req.params.id);
      res.json({
        success: true,
        data: { message: 'Automation rule deleted successfully' },
        error: null,
        requestId: req.requestId
      });
    } catch (error) {
      next(error);
    }
  }

  static async trigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = triggerSchema.parse(req.body);
      const result = await AutomationsService.triggerAutomation(payload);

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
}

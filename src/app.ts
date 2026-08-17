import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route imports
import healthRoutes from './modules/health/health.routes.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';
import messagesRoutes from './modules/messages/messages.routes.js';
import contactsRoutes from './modules/contacts/contacts.routes.js';
import automationsRoutes from './modules/automations/automations.routes.js';

export function createApp(): Express {
  const app = express();

  // 1. Security & Middleware
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  app.use(cors({
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id']
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);

  // 2. Base Index Route
  app.get('/', (req: Request, res: Response) => {
    res.json({
      success: true,
      service: 'tfc-whatsapp-service',
      description: 'The Foundation Collegiate WhatsApp Automation Microservice API',
      version: '1.0.0',
      health: '/api/v1/health',
      timestamp: new Date().toISOString()
    });
  });

  // 3. API V1 Routes
  app.use('/api/v1', healthRoutes);
  app.use('/api/v1/accounts', accountsRoutes);
  app.use('/api/v1/messages', messagesRoutes);
  app.use('/api/v1/contacts', contactsRoutes);
  app.use('/api/v1/automations', automationsRoutes);

  // 4. 404 Route Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      data: null,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Endpoint ${req.method} ${req.originalUrl} does not exist.`
      },
      requestId: (req as any).requestId || 'req_unknown'
    });
  });

  // 5. Centralized Error Handler
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { errorHandler } from './middleware/error';
import { requireAuth } from './middleware/auth';
import { loadContext } from './middleware/context';
import { requireLevel } from './middleware/guards';
import { authRouter } from './modules/auth/routes';
import { publicRouter } from './modules/public/routes';
import { platformRouter } from './modules/platform/routes';
import { adminRouter } from './modules/admin/routes';
import { appRouter } from './modules/app/routes';
import { requireWrite } from './middleware/guards';

/** App factory (no listen) so supertest can mount it. Module routers get registered here. */
export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/platform', requireAuth, loadContext, requireLevel('SUPER_ADMIN'), platformRouter);
  app.use('/api/admin', requireAuth, loadContext, requireLevel('ADMIN'), adminRouter);
  app.use('/api/app', requireAuth, loadContext, requireLevel('ADMIN', 'BRANCH_USER'), requireWrite, appRouter);

  app.use(errorHandler);
  return app;
}

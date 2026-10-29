import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { clientIp } from './requestLog';

/** Throw this from services/routes for expected failures. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input', details: err.flatten() } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'Already exists', details: err.meta } });
      return;
    }
  }
  // Unexpected: log the full stack server-side (with the request id); never leak it to the client in production.
  const ip = clientIp(req);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(`${req.method} ${req.originalUrl}  ip=${ip}  id=${req.id}\n${stack ?? String(err)}`, {
    errorLog: true,
    fields: { id: req.id, status: 500, method: req.method, path: req.originalUrl, ip, userId: req.auth?.userId ?? null, error: String(err), stack },
  });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong', id: req.id, ...(env.NODE_ENV === 'production' ? {} : { stack: err instanceof Error ? err.stack : String(err) }) } });
};

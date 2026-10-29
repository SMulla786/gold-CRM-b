import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/** Client IP without the IPv4-mapped "::ffff:" prefix. Real client only behind `trust proxy` (prod); in dev it's the proxy/tunnel hop. */
export const clientIp = (req: { ip?: string }): string => (req.ip ?? '-').replace(/^::ffff:/, '');

/** Assigns/propagates a request id and logs one entry per finished request (5xx as error, 4xx as warn).
 *  Terminal: `26-10 15:43:01 info: GET     200    12ms  127.0.0.1        /api/bills  id=…`; app log file: JSON with ip + userId.
 *  5xx stacks are logged separately by the error handler (server-side only). */
export const requestLog: RequestHandler = (req, res, next) => {
  // trust an inbound id only if it's short + safe (no log/header injection via a forged header)
  const inbound = req.headers['x-request-id'];
  req.id = typeof inbound === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(inbound) ? inbound : randomUUID();
  res.setHeader('x-request-id', req.id);
  if (env.NODE_ENV === 'test') return next(); // keep the request id, skip the per-request log line in the test runner
  const start = performance.now();
  res.on('finish', () => {
    const ms = Math.round(performance.now() - start);
    const ip = clientIp(req);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.log(level, `${req.method.padEnd(6)}  ${res.statusCode}  ${`${ms}ms`.padStart(6)}  ${ip.padEnd(15)}  ${req.originalUrl}  id=${req.id}`, {
      fields: { id: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms, ip, userId: req.auth?.userId ?? null },
    });
  });
  next();
};

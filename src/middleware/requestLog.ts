import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/** Assigns/propagates a request id and logs one structured JSON line per finished request.
 *  5xx stacks are logged separately by the error handler (server-side only). */
export const requestLog: RequestHandler = (req, res, next) => {
  req.id = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) || randomUUID();
  res.setHeader('x-request-id', req.id);
  if (env.NODE_ENV === 'test') return next(); // keep the request id, skip the per-request log line in the test runner
  const start = performance.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({ t: new Date().toISOString(), id: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(performance.now() - start) }),
    );
  });
  next();
};

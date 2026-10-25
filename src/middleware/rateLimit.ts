import type { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { HttpError } from './error';

interface Hit {
  count: number;
  resetAt: number;
}

/** Per-key fixed-window limiter, in process memory.
 *  shortcut: single-process only (counts don't cross nodes); move to Redis if the API scales past one instance. */
export function rateLimit(opts: { max: number; windowMs: number; key: (req: Request) => string }): RequestHandler {
  const hits = new Map<string, Hit>();
  return (req, res, next) => {
    const now = Date.now();
    // bound memory: drop expired windows when the map grows
    if (hits.size > 10_000) for (const [k, h] of hits) if (h.resetAt <= now) hits.delete(k);

    const k = opts.key(req);
    const h = hits.get(k);
    if (!h || h.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (h.count >= opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');
    }
    h.count += 1;
    next();
  };
}

/** Login + OTP guard: keyed by client IP + the submitted username (all three bodies carry `login`).
 *  Production-only — dev/test/E2E hammer login far past any sane limit; the factory itself is unit-tested.
 *  Needs `trust proxy` (set in app.ts for prod) so `req.ip` is the real client, not the Caddy hop. */
export const authRateLimit: RequestHandler =
  env.NODE_ENV === 'production'
    ? rateLimit({
        max: 10,
        windowMs: 15 * 60 * 1000,
        key: (req) => `${req.ip ?? 'noip'}:${typeof req.body?.login === 'string' ? req.body.login.toLowerCase() : ''}`,
      })
    : (_req, _res, next) => next();

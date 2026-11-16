import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { HttpError } from './error';
import { logImpersonatedWrite } from '../lib/activity';

export interface AuthContext {
  userId: number;
  sessionId: string;
  impersonatorId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

interface AccessTokenClaims {
  sub: number;
  sid: string;
  imp?: number;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

/** Verifies the Bearer access token and attaches req.auth. 401 UNAUTHENTICATED when missing/invalid/expired. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  let payload: jwt.JwtPayload & AccessTokenClaims;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & AccessTokenClaims;
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
  req.auth = { userId: Number(payload.sub), sessionId: payload.sid, impersonatorId: payload.imp ?? null };
  const { userId, impersonatorId } = req.auth;
  // G7 review 4: every write made while impersonating is audited with BOTH identities, whether it was allowed or refused
  if (impersonatorId != null && req.method !== 'GET') {
    const path = req.originalUrl.split('?')[0]!;
    // G7 closure: logged when the handler ends the response, with the status it set — not on 'finish', which never fires once
    // the client has hung up, though the handler still makes its write. Once per request.
    const end = res.end as (...args: unknown[]) => typeof res;
    let logged = false;
    res.end = ((...args: unknown[]) => {
      if (!logged) {
        logged = true;
        void logImpersonatedWrite({ businessId: req.ctx?.businessId ?? null, branchId: req.ctx ? (req.ctx.activeBranchId ?? req.ctx.scopeBranchId) : null, userId, impersonatorId, method: req.method, path, status: res.statusCode });
      }
      return end.apply(res, args);
    }) as typeof res.end;
  }
  next();
};

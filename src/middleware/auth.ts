import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { HttpError } from './error';

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
export const requireAuth: RequestHandler = (req, _res, next) => {
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
  next();
};

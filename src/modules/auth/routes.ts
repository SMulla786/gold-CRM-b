import { Router } from 'express';
import type { Request } from 'express';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { authRateLimit } from '../../middleware/rateLimit';
import {
  REFRESH_COOKIE,
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  resetPasswordBody,
  setMpinBody,
  verifyMpinBody,
} from '../../shared';
import * as svc from './service';

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400000,
};
const meta = (req: Request): svc.SessionMeta => ({ userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null });

export const authRouter = Router();

authRouter.post('/login', authRateLimit, async (req, res) => {
  const { response, refreshToken } = await svc.login(loginBody.parse(req.body), meta(req));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts).json(response);
});

authRouter.post('/refresh', async (req, res) => {
  const { accessToken, refreshToken } = await svc.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts).json({ accessToken });
});

authRouter.post('/logout', async (req, res) => {
  await svc.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' }).status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await svc.buildMe(req.auth!.userId, req.auth!.impersonatorId));
});

authRouter.post('/password', requireAuth, async (req, res) => {
  await svc.changePassword(req.auth!.userId, req.auth!.sessionId, changePasswordBody.parse(req.body));
  res.status(204).end();
});

authRouter.post('/mpin', requireAuth, async (req, res) => {
  await svc.setMpin(req.auth!.userId, setMpinBody.parse(req.body));
  res.status(204).end();
});

authRouter.post('/mpin/verify', requireAuth, async (req, res) => {
  await svc.verifyMpin(req.auth!.userId, verifyMpinBody.parse(req.body).mpin);
  res.status(204).end();
});

authRouter.post('/forgot-password', authRateLimit, async (req, res) => {
  await svc.forgotPassword(forgotPasswordBody.parse(req.body).login);
  res.status(202).end();
});

authRouter.post('/reset-password', authRateLimit, async (req, res) => {
  await svc.resetPassword(resetPasswordBody.parse(req.body));
  res.status(204).end();
});

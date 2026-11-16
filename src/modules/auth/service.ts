import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { HttpError } from '../../middleware/error';
import { signAccessToken } from '../../middleware/auth';
import { loadAccess } from '../../lib/access';
import type { BranchRef, LoginResponse, MeDto, PermissionMap } from '../../shared';
import { ALL_PERMISSIONS, buildPermissionMap, otpStubEnabled } from './logic';

const REFRESH_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 86400000;
const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
const verify = (hash: string, plain: string): Promise<boolean> => argon2.verify(hash, plain).catch(() => false);

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

const toRef = (b: {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
  depth: number;
  isAdminNode: boolean;
  isActive: boolean;
}): BranchRef => ({ id: b.id, name: b.name, parentId: b.parentId, path: b.path, depth: b.depth, isAdminNode: b.isAdminNode, isActive: b.isActive });

/** Creates a refresh session (stored hashed) and the access token, returns the raw refresh token for the cookie. */
async function createSession(
  userId: number,
  impersonatorId: number | null,
  meta: SessionMeta,
): Promise<{ refreshToken: string; accessToken: string; me: MeDto }> {
  const refreshToken = randomBytes(32).toString('base64url');
  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      impersonatorId: impersonatorId ?? undefined,
      userAgent: meta.userAgent ?? undefined,
      ip: meta.ip ?? undefined,
    },
  });
  const accessToken = signAccessToken({ sub: userId, sid: session.id, imp: impersonatorId ?? undefined });
  const me = await buildMe(userId, impersonatorId);
  return { refreshToken, accessToken, me };
}

export async function login(input: { login: string; password: string }, meta: SessionMeta): Promise<{ response: LoginResponse; refreshToken: string }> {
  const user = await prisma.user.findFirst({
    where: { OR: [{ username: input.login.toLowerCase() }, { email: input.login }] },
  });
  const invalid = new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid login or password');
  if (!user || !(await verify(user.passwordHash, input.password))) throw invalid;
  if (user.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_BLOCKED', 'Account is blocked');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const { refreshToken, accessToken, me } = await createSession(user.id, null, meta);
  return { response: { accessToken, user: me }, refreshToken };
}

/** Two tabs of one browser share the cookie and may refresh at the same moment: a duplicate within this window is not theft. */
export const REFRESH_GRACE_MS = 5000;
// The successor token is derived from the presented one (server-keyed), so a duplicate re-derives the SAME token without
// any raw token ever being stored. Only a holder of the old token can derive it — and that holder could refresh anyway.
const successorToken = (raw: string): string => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`rt-successor:${raw}`).digest('base64url');

type RefreshOutcome = { accessToken: string; refreshToken: string } | { fail: string; revokeAllOf?: number };

export async function refresh(rawToken: string | undefined, meta: SessionMeta): Promise<{ accessToken: string; refreshToken: string }> {
  if (!rawToken) throw new HttpError(401, 'UNAUTHENTICATED', 'No refresh token');
  const nextToken = successorToken(rawToken);
  const hash = hashToken(rawToken);
  const out = await prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
    // G7 closure — lock order User → Session, as every revoke (password change / reset, admin reset, block, theft sign-out:
    // the user row, then its sessions, in one tx): a revoke running meanwhile waits for this rotation and then sees the
    // successor, instead of taking its snapshot first and leaving the successor live.
    const [owner] = await tx.$queryRaw<{ userId: number }[]>`SELECT "userId" FROM "Session" WHERE "refreshTokenHash" = ${hash}`;
    if (owner) await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${owner.userId} FOR SHARE`;
    // Then the session row: a simultaneous duplicate waits here until this rotation commits, then reads it below.
    const hit = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Session" WHERE "refreshTokenHash" = ${hash} FOR NO KEY UPDATE`;
    const session = hit[0] ? await tx.session.findUnique({ where: { id: hit[0].id } }) : null;
    if (!session) return { fail: 'Invalid refresh token' };
    const user = await tx.user.findUnique({ where: { id: session.userId }, select: { status: true } });
    const now = new Date();
    if (session.revokedAt) {
      // Ended on purpose (logout, password change/reset, block, impersonation end…): just over — no grace, no mass sign-out.
      if (session.revokeReason) return { fail: 'Session ended' };
      if (user?.status !== 'ACTIVE') return { fail: 'Account unavailable' };
      const next = session.replacedById ? await tx.session.findUnique({ where: { id: session.replacedById } }) : null;
      const inGrace = now.getTime() - session.revokedAt.getTime() <= REFRESH_GRACE_MS;
      if (next && inGrace && !next.revokedAt && next.expiresAt > now && next.userAgent === (meta.userAgent ?? null)) {
        return { accessToken: signAccessToken({ sub: next.userId, sid: next.id, imp: next.impersonatorId ?? undefined }), refreshToken: nextToken };
      }
      // its successor was ended on purpose (a logout / block racing this refresh): over, not theft
      if (next?.revokeReason) return { fail: 'Session ended' };
      // Reuse of an already-rotated token outside the window ⇒ treat as theft: revoke every live session for the user.
      return { fail: 'Refresh token reused', revokeAllOf: session.userId };
    }
    if (session.expiresAt < now) return { fail: 'Refresh token expired' };
    // Blocked/deleted users must not be able to keep refreshing a live session.
    if (!user || user.status !== 'ACTIVE') {
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: now, revokeReason: user?.status ?? 'DELETED' } });
      return { fail: 'Account unavailable' };
    }
    const next = await tx.session.create({
      data: {
        userId: session.userId,
        refreshTokenHash: hashToken(nextToken),
        expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        impersonatorId: session.impersonatorId ?? undefined,
        userAgent: meta.userAgent ?? undefined,
        ip: meta.ip ?? undefined,
      },
    });
    await tx.session.update({ where: { id: session.id }, data: { revokedAt: now, replacedById: next.id } });
    return { accessToken: signAccessToken({ sub: next.userId, sid: next.id, imp: next.impersonatorId ?? undefined }), refreshToken: nextToken };
  });
  if ('fail' in out) {
    if (out.revokeAllOf) await prisma.session.updateMany({ where: { userId: out.revokeAllOf, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new HttpError(401, 'UNAUTHENTICATED', out.fail);
  }
  return out;
}

/** Ends the cookie's session. If another tab's refresh rotated it a moment ago, ends the successor too — a logout is never undone. */
export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  let where: { refreshTokenHash: string } | { id: string } = { refreshTokenHash: hashToken(rawToken) };
  for (let hop = 0; hop < 3; hop++) {
    // the guarded update waits on a refresh holding the row, then sees whether it rotated
    const ended = await prisma.session.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'LOGOUT' } });
    if (ended.count) return;
    const s: { revokeReason: string | null; replacedById: string | null } | null = await prisma.session.findUnique({ where, select: { revokeReason: true, replacedById: true } });
    if (!s?.replacedById || s.revokeReason) return;
    where = { id: s.replacedById };
  }
}

export async function buildMe(userId: number, impersonatorId: number | null = null): Promise<MeDto> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { business: true, branch: true } });
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User not found');

  let accessibleBranches: BranchRef[] = [];
  if (user.level === 'ADMIN' && user.branch) {
    const rows = await prisma.branch.findMany({
      where: { businessId: user.businessId!, path: { startsWith: user.branch.path } },
      orderBy: { path: 'asc' },
    });
    accessibleBranches = rows.map(toRef);
  } else if (user.level === 'BRANCH_USER' && user.branch) {
    const extra = await prisma.branch.findMany({ where: { extraUsers: { some: { userId } } }, orderBy: { path: 'asc' } });
    accessibleBranches = [toRef(user.branch), ...extra.map(toRef)];
  }

  let permissions: PermissionMap;
  if (user.level === 'SUPER_ADMIN' || user.level === 'ADMIN') {
    permissions = ALL_PERMISSIONS;
  } else {
    const [rolePerms, overrides] = await Promise.all([
      user.roleId
        ? prisma.rolePermission.findMany({ where: { roleId: user.roleId, permission: { isModule: false } }, include: { permission: true } })
        : Promise.resolve([]),
      prisma.userPermission.findMany({ where: { userId, permission: { isModule: false } }, include: { permission: true } }),
    ]);
    permissions = buildPermissionMap(
      rolePerms.map((r) => ({ key: r.permission.key, canView: r.canView, canEdit: r.canEdit, canDelete: r.canDelete })),
      overrides.map((o) => ({ key: o.permission.key, canView: o.canView, canEdit: o.canEdit, canDelete: o.canDelete })),
    );
  }

  let modules: string[] = [];
  let subscription: MeDto['subscription'] = null;
  if (user.level !== 'SUPER_ADMIN' && user.business) {
    const access = await loadAccess(user.business.id, user.business.status);
    modules = access.modules;
    // Phase 5: never ads while a Super Admin is impersonating (the client also blocks them; this keeps it server-true)
    subscription = access.subscription && impersonatorId ? { ...access.subscription, adEligible: false } : access.subscription;
  }

  const impersonatedBy = impersonatorId ? await prisma.user.findUnique({ where: { id: impersonatorId }, select: { id: true, name: true } }) : null;

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    level: user.level,
    isOwner: user.isOwner,
    business: user.business ? { id: user.business.id, name: user.business.name, status: user.business.status } : null,
    branch: user.branch ? toRef(user.branch) : null,
    accessibleBranches,
    permissions,
    modules,
    subscription,
    hasMpin: !!user.mpinHash,
    impersonatedBy,
  };
}

export async function changePassword(userId: number, currentSessionId: string, input: { current: string; next: string }): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verify(user.passwordHash, input.current))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid password');
  const passwordHash = await argon2.hash(input.next);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.updateMany({ where: { userId, revokedAt: null, NOT: { id: currentSessionId } }, data: { revokedAt: new Date(), revokeReason: 'PASSWORD_CHANGED' } }),
  ]);
}

export async function setMpin(userId: number, input: { password: string; mpin: string }): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verify(user.passwordHash, input.password))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid password');
  await prisma.user.update({ where: { id: userId }, data: { mpinHash: await argon2.hash(input.mpin) } });
}

export async function verifyMpin(userId: number, mpin: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mpinHash || !(await verify(user.mpinHash, mpin))) throw new HttpError(403, 'MPIN_REQUIRED', 'Invalid MPIN');
}

export async function forgotPassword(loginStr: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { OR: [{ username: loginStr.toLowerCase() }, { email: loginStr }] } });
  if (!user) return; // no account enumeration
  const otp = String(randomInt(100000, 1000000));
  await prisma.otpCode.create({ data: { userId: user.id, purpose: 'PASSWORD_RESET', codeHash: await argon2.hash(otp), expiresAt: new Date(Date.now() + 10 * 60000) } });
  // Terminal only: process.stdout.write bypasses the logger's file transports and the console.log tee in lib/fileLog.ts.
  if (otpStubEnabled(env.NODE_ENV, env.OTP_STUB)) process.stdout.write(`[OTP stub] password reset for ${user.username}: ${otp}\n`);
}

export async function resetPassword(input: { login: string; otp: string; next: string }): Promise<void> {
  const invalid = new HttpError(400, 'VALIDATION', 'Invalid or expired OTP');
  const user = await prisma.user.findFirst({ where: { OR: [{ username: input.login.toLowerCase() }, { email: input.login }] } });
  if (!user) throw invalid;
  const otp = await prisma.otpCode.findFirst({
    where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gte: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) throw invalid;
  if (!(await verify(otp.codeHash, input.otp))) {
    const attempts = otp.attempts + 1;
    // Lock the OTP after 5 wrong tries by consuming it.
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts, consumedAt: attempts >= 5 ? new Date() : null } });
    throw invalid;
  }
  const nextHash = await argon2.hash(input.next);
  await prisma.$transaction([
    prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: nextHash } }),
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'PASSWORD_RESET' } }),
  ]);
}

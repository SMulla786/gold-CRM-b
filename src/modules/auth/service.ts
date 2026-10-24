import { createHash, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { HttpError } from '../../middleware/error';
import { signAccessToken } from '../../middleware/auth';
import { loadAccess } from '../../lib/access';
import type { BranchRef, LoginResponse, MeDto, PermissionMap } from '../../shared';
import { ALL_PERMISSIONS, buildPermissionMap } from './logic';

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
}): BranchRef => ({ id: b.id, name: b.name, parentId: b.parentId, path: b.path, depth: b.depth, isAdminNode: b.isAdminNode });

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

export async function refresh(rawToken: string | undefined, meta: SessionMeta): Promise<{ accessToken: string; refreshToken: string }> {
  if (!rawToken) throw new HttpError(401, 'UNAUTHENTICATED', 'No refresh token');
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(rawToken) } });
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
  if (session.revokedAt) {
    // Reuse of an already-rotated token ⇒ treat as theft: revoke every live session for the user.
    await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Refresh token reused');
  }
  if (session.expiresAt < new Date()) throw new HttpError(401, 'UNAUTHENTICATED', 'Refresh token expired');
  // Blocked/deleted users must not be able to keep refreshing a live session.
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { status: true } });
  if (!user || user.status !== 'ACTIVE') {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Account unavailable');
  }
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const { refreshToken, accessToken } = await createSession(session.userId, session.impersonatorId ?? null, meta);
  return { accessToken, refreshToken };
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (rawToken) {
    await prisma.session.updateMany({ where: { refreshTokenHash: hashToken(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
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
    subscription = access.subscription;
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
    prisma.session.updateMany({ where: { userId, revokedAt: null, NOT: { id: currentSessionId } }, data: { revokedAt: new Date() } }),
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
  if (env.NODE_ENV !== 'production') console.log(`[OTP stub] password reset for ${user.username}: ${otp}`);
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
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

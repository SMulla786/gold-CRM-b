import type { RequestHandler } from 'express';
import { prisma } from '../lib/prisma';
import { loadAccess } from '../lib/access';
import { ALL_PERMISSIONS, buildPermissionMap } from '../modules/auth/logic';
import { HEADERS } from '../shared';
import type { PermissionMap, UserLevel } from '../shared';
import { HttpError } from './error';

/** Resolved per-request tenant context. Scoping and guards read only from here, never from the raw token. */
export interface TenantContext {
  userId: number;
  level: UserLevel;
  isOwner: boolean;
  businessId: number | null; // null for SUPER_ADMIN
  scopeBranchId: number | null; // node the user is attached to
  branchIds: number[]; // subtree (ADMIN) or own + extra (BRANCH_USER); [] for SUPER_ADMIN
  activeBranchId: number | null; // X-Branch-Id for admins (null = "all"); own branch for BRANCH_USER
  readOnly: boolean;
  modules: string[];
  limits: { maxBranches: number; maxUsers: number } | null;
  permissions: PermissionMap;
  impersonatorId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: TenantContext;
    }
  }
}

/**
 * Loads the user + session fresh every request so a block/logout takes effect immediately
 * (access tokens otherwise stay valid for their 15-min TTL). Attaches req.ctx. Requires requireAuth first.
 */
export const loadContext: RequestHandler = async (req, _res, next) => {
  const auth = req.auth;
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');

  const session = await prisma.session.findUnique({ where: { id: auth.sessionId }, select: { revokedAt: true, expiresAt: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired');

  const user = await prisma.user.findUnique({ where: { id: auth.userId }, include: { branch: true, business: true } });
  if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'UNAUTHENTICATED', 'Account unavailable');

  let branchIds: number[] = [];
  if (user.level === 'ADMIN' && user.branch) {
    const rows = await prisma.branch.findMany({ where: { businessId: user.businessId!, path: { startsWith: user.branch.path } }, select: { id: true } });
    branchIds = rows.map((r) => r.id);
  } else if (user.level === 'BRANCH_USER' && user.branch) {
    const extra = await prisma.userBranchAccess.findMany({ where: { userId: user.id }, select: { branchId: true } });
    branchIds = [user.branch.id, ...extra.map((e) => e.branchId)];
  }

  let permissions: PermissionMap;
  if (user.level === 'SUPER_ADMIN' || user.level === 'ADMIN') {
    permissions = ALL_PERMISSIONS;
  } else {
    const [rolePerms, overrides] = await Promise.all([
      user.roleId
        ? prisma.rolePermission.findMany({ where: { roleId: user.roleId, permission: { isModule: false } }, include: { permission: true } })
        : Promise.resolve([]),
      prisma.userPermission.findMany({ where: { userId: user.id, permission: { isModule: false } }, include: { permission: true } }),
    ]);
    permissions = buildPermissionMap(
      rolePerms.map((r) => ({ key: r.permission.key, canView: r.canView, canEdit: r.canEdit, canDelete: r.canDelete })),
      overrides.map((o) => ({ key: o.permission.key, canView: o.canView, canEdit: o.canEdit, canDelete: o.canDelete })),
    );
  }

  let readOnly = false;
  let modules: string[] = [];
  let limits: TenantContext['limits'] = null;
  if (user.level !== 'SUPER_ADMIN' && user.business) {
    const access = await loadAccess(user.business.id, user.business.status);
    readOnly = access.readOnly;
    modules = access.modules;
    limits = access.limits;
  }

  let activeBranchId: number | null = null;
  if (user.level === 'ADMIN') {
    const header = req.header(HEADERS.BRANCH);
    if (header && header !== 'all') {
      const bid = Number(header);
      if (!Number.isInteger(bid) || !branchIds.includes(bid)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
      activeBranchId = bid;
    }
  } else if (user.level === 'BRANCH_USER') {
    activeBranchId = user.branchId ?? null;
  }

  req.ctx = {
    userId: user.id,
    level: user.level,
    isOwner: user.isOwner,
    businessId: user.businessId ?? null,
    scopeBranchId: user.branchId ?? null,
    branchIds,
    activeBranchId,
    readOnly,
    modules,
    limits,
    permissions,
    impersonatorId: auth.impersonatorId,
  };
  next();
};

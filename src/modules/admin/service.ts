import argon2 from 'argon2';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { HttpError } from '../../middleware/error';
import { assertWithinLimit } from '../../middleware/guards';
import type { TenantContext } from '../../middleware/context';
import { MODULES } from '../../shared';
import type {
  BranchNodeDto,
  BusinessProfileDto,
  CounterDto,
  ModuleDef,
  Paged,
  PermissionGrantDto,
  RoleDto,
  SubscriptionPaymentRowDto,
  SubscriptionViewDto,
  UserDto,
  UserPermissionsDto,
} from '../../shared';

// Rows loaded through scopedDb carry their relations; we type the mappers structurally to avoid Prisma generics noise.
/* eslint-disable @typescript-eslint/no-explicit-any */
const branchNode = (b: any): BranchNodeDto => ({
  id: b.id,
  parentId: b.parentId,
  name: b.name,
  code: b.code,
  path: b.path,
  depth: b.depth,
  isAdminNode: b.isAdminNode,
  isActive: b.isActive,
  userCount: 0,
  children: [],
  inchargeName: b.inchargeName,
  countryCode: b.countryCode,
  mobile: b.mobile,
  gstin: b.gstin,
  stateId: b.stateId,
  districtId: b.districtId,
  address: b.address,
  disclaimer: b.disclaimer,
});

const userDto = (u: any): UserDto => ({
  id: u.id,
  name: u.name,
  username: u.username,
  email: u.email,
  mobile: u.mobile,
  level: u.level,
  isOwner: u.isOwner,
  status: u.status,
  branch: { id: u.branch.id, name: u.branch.name },
  role: u.role ? { id: u.role.id, name: u.role.name } : null,
  extraBranchIds: u.extraBranches.map((e: any) => e.branchId),
  viewDaysLimit: u.viewDaysLimit,
  lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Edit or delete implies view (normalised server-side). */
const normalizeGrant = (g: PermissionGrantDto): PermissionGrantDto => ({ ...g, view: g.view || g.edit || g.delete });

/** Roles are business-wide: only the owner or an admin attached to the ROOT branch may create/edit them. */
async function assertRoleManager(ctx: TenantContext): Promise<void> {
  if (ctx.isOwner) return;
  const branch = ctx.scopeBranchId != null ? await prisma.branch.findUnique({ where: { id: ctx.scopeBranchId } }) : null;
  if (!branch || branch.parentId !== null) throw new HttpError(403, 'FORBIDDEN', 'Only the owner or a root admin can manage roles');
}

// ───────────── Branches ─────────────

export async function getBranchTree(ctx: TenantContext): Promise<BranchNodeDto> {
  const sdb = scopedDb(ctx);
  const rows = await sdb.branch.findMany({ orderBy: { path: 'asc' } });
  const users = await sdb.user.findMany({ select: { branchId: true } });
  const counts = new Map<number, number>();
  for (const u of users) if (u.branchId != null) counts.set(u.branchId, (counts.get(u.branchId) ?? 0) + 1);

  const nodes = new Map<number, BranchNodeDto>();
  for (const b of rows) nodes.set(b.id, { ...branchNode(b), userCount: counts.get(b.id) ?? 0 });
  let root: BranchNodeDto | undefined;
  for (const b of rows) {
    const node = nodes.get(b.id)!;
    const parent = b.parentId != null ? nodes.get(b.parentId) : undefined;
    if (parent) parent.children.push(node);
    else root = node; // the subtree root (caller's node) has no parent inside the scoped set
  }
  if (!root) throw new HttpError(404, 'NOT_FOUND', 'No accessible branch');
  return root;
}

/** Branch state/district must exist and agree (an unknown id would otherwise hit the FK → 500). */
async function assertBranchGeo(stateId: number | null | undefined, districtId: number | null | undefined): Promise<void> {
  if (stateId != null && !(await prisma.state.findUnique({ where: { id: stateId } }))) throw new HttpError(400, 'VALIDATION', 'Unknown state');
  if (districtId == null) return;
  const district = await prisma.district.findUnique({ where: { id: districtId } });
  if (!district) throw new HttpError(400, 'VALIDATION', 'Unknown district');
  if (stateId != null && district.stateId !== stateId) throw new HttpError(400, 'VALIDATION', 'District is not in the selected state');
}

export async function createBranch(ctx: TenantContext, body: {
  parentId: number;
  name: string;
  code?: string;
  isAdminNode: boolean;
  inchargeName?: string;
  countryCode: string;
  mobile?: string;
  gstin?: string;
  stateId?: number;
  districtId?: number;
  address?: string;
  disclaimer?: string;
}): Promise<BranchNodeDto> {
  const parent = await scopedDb(ctx).branch.findUnique({ where: { id: body.parentId } });
  if (!parent) throw new HttpError(404, 'NOT_FOUND', 'Parent branch not found');
  const total = await prisma.branch.count({ where: { businessId: ctx.businessId! } });
  assertWithinLimit(total, ctx.limits?.maxBranches, 'branches');
  await assertBranchGeo(body.stateId, body.districtId);

  const created = await prisma.$transaction(async (tx) => {
    const b = await tx.branch.create({
      data: {
        businessId: ctx.businessId!,
        parentId: parent.id,
        name: body.name,
        code: body.code ?? null,
        isAdminNode: body.isAdminNode,
        inchargeName: body.inchargeName ?? null,
        countryCode: body.countryCode,
        mobile: body.mobile ?? null,
        gstin: body.gstin ?? null,
        stateId: body.stateId ?? null,
        districtId: body.districtId ?? null,
        address: body.address ?? null,
        disclaimer: body.disclaimer ?? null,
        depth: parent.depth + 1,
        path: '',
      },
    });
    return tx.branch.update({ where: { id: b.id }, data: { path: `${parent.path}${b.id}/` } });
  });
  return branchNode(created);
}

export async function updateBranch(ctx: TenantContext, branchId: number, body: Record<string, unknown>): Promise<BranchNodeDto> {
  const sdb = scopedDb(ctx);
  const branch = await sdb.branch.findUnique({ where: { id: branchId } }); // 404 when outside subtree
  if (!branch) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const protectedNode = branchId === ctx.scopeBranchId || branch.parentId === null;
  if (protectedNode && (body.isAdminNode !== undefined || body.isActive !== undefined)) {
    throw new HttpError(400, 'VALIDATION', 'Cannot change admin-node/active status of your own node or the root branch');
  }
  // a district edited alone is checked against the branch's current state; null clears either
  if (body.stateId !== undefined || body.districtId !== undefined) {
    const stateId = (body.stateId !== undefined ? body.stateId : branch.stateId) as number | null;
    await assertBranchGeo(stateId, (body.districtId !== undefined ? body.districtId : branch.districtId) as number | null);
  }
  const updated = await sdb.branch.update({ where: { id: branchId }, data: body });
  return branchNode(updated);
}

export async function moveBranch(ctx: TenantContext, branchId: number, newParentId: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const [branch, newParent] = await Promise.all([
    sdb.branch.findUnique({ where: { id: branchId } }),
    sdb.branch.findUnique({ where: { id: newParentId } }),
  ]);
  if (!branch || !newParent) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  if (branch.parentId == null) throw new HttpError(400, 'VALIDATION', 'Cannot move the root branch');
  if (newParent.path.startsWith(branch.path)) throw new HttpError(400, 'VALIDATION', 'Cannot move a branch under its own descendant');

  const oldPath = branch.path;
  const newBase = `${newParent.path}${branch.id}/`;
  const depthDelta = newParent.depth + 1 - branch.depth;
  await prisma.$transaction(async (tx) => {
    const subtree = await tx.branch.findMany({ where: { businessId: ctx.businessId!, path: { startsWith: oldPath } } });
    for (const s of subtree) {
      await tx.branch.update({
        where: { id: s.id },
        data: {
          path: newBase + s.path.slice(oldPath.length),
          depth: s.depth + depthDelta,
          ...(s.id === branch.id ? { parentId: newParent.id } : {}),
        },
      });
    }
  });
}

// ───────────── Counters ─────────────

export async function listCounters(ctx: TenantContext, branchId?: number): Promise<CounterDto[]> {
  const sdb = scopedDb(ctx);
  if (branchId != null) {
    const b = await sdb.branch.findUnique({ where: { id: branchId } });
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  }
  const rows = await sdb.counter.findMany({ where: branchId != null ? { branchId } : {}, include: { branch: true }, orderBy: { id: 'asc' } });
  return rows.map((c) => ({ id: c.id, branchId: c.branchId, branchName: c.branch.name, name: c.name, isActive: c.isActive }));
}

export async function createCounter(ctx: TenantContext, body: { branchId: number; name: string }): Promise<CounterDto> {
  const branch = await scopedDb(ctx).branch.findUnique({ where: { id: body.branchId } });
  if (!branch) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const c = await scopedDb(ctx).counter.create({ data: { branchId: body.branchId, name: body.name } as never });
  return { id: c.id, branchId: c.branchId, branchName: branch.name, name: c.name, isActive: c.isActive };
}

export async function updateCounter(ctx: TenantContext, counterId: number, body: { name?: string; isActive?: boolean }): Promise<CounterDto> {
  const c = await scopedDb(ctx).counter.update({ where: { id: counterId }, data: { name: body.name, isActive: body.isActive }, include: { branch: true } });
  return { id: c.id, branchId: c.branchId, branchName: c.branch.name, name: c.name, isActive: c.isActive };
}

// ───────────── Users ─────────────

export async function listUsers(ctx: TenantContext, query: { page: number; pageSize: number; q?: string; branchId?: number; status?: 'ACTIVE' | 'BLOCKED' | 'DELETED' }): Promise<Paged<UserDto>> {
  const sdb = scopedDb(ctx);
  const where = {
    ...(query.branchId != null ? { branchId: query.branchId } : {}),
    // No status = everyone except trashed users (the Trash tab asks for DELETED explicitly).
    status: query.status ?? { not: 'DELETED' as const },
    ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { username: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.user.findMany({ where, include: { branch: true, role: true, extraBranches: true }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { id: 'asc' } }),
    sdb.user.count({ where }),
  ]);
  return { items: rows.map(userDto), total, page: query.page, pageSize: query.pageSize };
}

export async function getUser(ctx: TenantContext, userId: number): Promise<UserDto> {
  const u = await scopedDb(ctx).user.findUnique({ where: { id: userId }, include: { branch: true, role: true, extraBranches: true } });
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  return userDto(u);
}

export async function createUser(ctx: TenantContext, body: {
  name: string;
  username: string;
  password: string;
  mpin?: string;
  email?: string;
  mobile?: string;
  level: 'ADMIN' | 'BRANCH_USER';
  branchId: number;
  roleId?: number;
  extraBranchIds: number[];
  viewDaysLimit?: number | null;
}): Promise<UserDto> {
  const sdb = scopedDb(ctx);
  const branch = await sdb.branch.findUnique({ where: { id: body.branchId } });
  if (!branch) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  if (body.level === 'ADMIN' && !branch.isAdminNode) throw new HttpError(400, 'VALIDATION', 'Admin users must be on an admin-node branch');
  if (body.roleId != null) {
    const role = await prisma.role.findFirst({ where: { id: body.roleId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } });
    if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');
  }
  for (const bid of body.extraBranchIds) {
    if (!(await sdb.branch.findUnique({ where: { id: bid } }))) throw new HttpError(404, 'NOT_FOUND', 'Extra branch not found');
  }
  const total = await prisma.user.count({ where: { businessId: ctx.businessId! } });
  assertWithinLimit(total, ctx.limits?.maxUsers, 'users');

  const created = await prisma.user.create({
    data: {
      businessId: ctx.businessId!,
      branchId: body.branchId,
      level: body.level,
      roleId: body.roleId ?? null,
      name: body.name,
      username: body.username,
      email: body.email ?? null,
      mobile: body.mobile ?? null,
      passwordHash: await argon2.hash(body.password),
      mpinHash: body.mpin ? await argon2.hash(body.mpin) : null,
      viewDaysLimit: body.viewDaysLimit ?? null,
      createdById: ctx.userId,
      extraBranches: { create: body.extraBranchIds.map((branchId) => ({ branchId })) },
    },
    include: { branch: true, role: true, extraBranches: true },
  });
  return userDto(created);
}

export async function updateUser(ctx: TenantContext, userId: number, body: {
  name?: string;
  email?: string;
  mobile?: string;
  level?: 'ADMIN' | 'BRANCH_USER';
  branchId?: number;
  roleId?: number;
  extraBranchIds?: number[];
  viewDaysLimit?: number | null;
}): Promise<UserDto> {
  const sdb = scopedDb(ctx);
  const target = await sdb.user.findUnique({ where: { id: userId }, include: { branch: true } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (target.isOwner && !ctx.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Only the owner can edit the owner');
  if (target.id === ctx.userId && ((body.level != null && body.level !== target.level) || (body.branchId != null && body.branchId !== target.branchId))) {
    throw new HttpError(403, 'FORBIDDEN', 'You cannot change your own level or branch');
  }

  // Validate every changed FK against the caller's scope.
  let effectiveBranch = target.branch;
  if (body.branchId != null && body.branchId !== target.branchId) {
    const b = await sdb.branch.findUnique({ where: { id: body.branchId } });
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
    effectiveBranch = b;
  }
  const effectiveLevel = body.level ?? target.level;
  if (effectiveLevel === 'ADMIN' && effectiveBranch && !effectiveBranch.isAdminNode) {
    throw new HttpError(400, 'VALIDATION', 'Admin users must be on an admin-node branch');
  }
  if (body.roleId != null) {
    const role = await prisma.role.findFirst({ where: { id: body.roleId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } });
    if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');
  }
  if (body.extraBranchIds) {
    for (const bid of body.extraBranchIds) {
      if (!(await sdb.branch.findUnique({ where: { id: bid } }))) throw new HttpError(404, 'NOT_FOUND', 'Extra branch not found');
    }
  }

  const { extraBranchIds, ...rest } = body;
  await sdb.user.update({ where: { id: userId }, data: rest });
  if (extraBranchIds) {
    await prisma.$transaction([
      prisma.userBranchAccess.deleteMany({ where: { userId } }),
      prisma.userBranchAccess.createMany({ data: extraBranchIds.map((branchId) => ({ userId, branchId })) }),
    ]);
  }
  return getUser(ctx, userId);
}

/** BLOCKED / DELETED (trash, soft) both revoke sessions; ACTIVE = unblock or restore from trash. */
export async function setUserStatus(ctx: TenantContext, userId: number, status: 'ACTIVE' | 'BLOCKED' | 'DELETED'): Promise<void> {
  const target = await scopedDb(ctx).user.findUnique({ where: { id: userId } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (status === 'DELETED' && target.isOwner) throw new HttpError(403, 'FORBIDDEN', 'The owner cannot be deleted');
  if (target.isOwner && !ctx.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Only the owner can block the owner');
  if (status !== 'ACTIVE' && target.id === ctx.userId) throw new HttpError(403, 'FORBIDDEN', 'You cannot block or delete yourself');
  await scopedDb(ctx).user.update({ where: { id: userId }, data: { status } });
  if (status !== 'ACTIVE') await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: status } });
}

/** An impersonating Super Admin acts as the owner, but must never reset the owner's own password or MPIN. */
function assertNotImpersonatingOwner(ctx: TenantContext, target: { isOwner: boolean }): void {
  if (ctx.impersonatorId != null && target.isOwner) throw new HttpError(403, 'FORBIDDEN', "Not allowed while impersonating: the owner's credentials");
}

export async function resetUserPassword(ctx: TenantContext, userId: number, password: string): Promise<void> {
  const target = await scopedDb(ctx).user.findUnique({ where: { id: userId } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (target.isOwner && !ctx.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Only the owner can reset the owner');
  assertNotImpersonatingOwner(ctx, target);
  await scopedDb(ctx).user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(password) } });
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'ADMIN_RESET' } });
}

/** Admin sets/resets a user's MPIN (staff otherwise can't pass MPIN-gated actions until they set one themselves). */
export async function resetUserMpin(ctx: TenantContext, userId: number, mpin: string): Promise<void> {
  const target = await scopedDb(ctx).user.findUnique({ where: { id: userId } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (target.isOwner && !ctx.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Only the owner can reset the owner');
  assertNotImpersonatingOwner(ctx, target);
  await scopedDb(ctx).user.update({ where: { id: userId }, data: { mpinHash: await argon2.hash(mpin) } });
}

// ───────────── Permissions & Roles ─────────────

export function permissionCatalog(): ModuleDef[] {
  return MODULES;
}

export async function getUserPermissions(ctx: TenantContext, userId: number): Promise<UserPermissionsDto> {
  const u = await scopedDb(ctx).user.findUnique({ where: { id: userId } });
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  const [rolePerms, overrides] = await Promise.all([
    u.roleId ? prisma.rolePermission.findMany({ where: { roleId: u.roleId, permission: { isModule: false } }, include: { permission: true } }) : Promise.resolve([]),
    prisma.userPermission.findMany({ where: { userId, permission: { isModule: false } }, include: { permission: true } }),
  ]);
  const map = new Map<string, PermissionGrantDto>();
  for (const r of rolePerms) map.set(r.permission.key, { key: r.permission.key, view: r.canView, edit: r.canEdit, delete: r.canDelete });
  const overriddenKeys: string[] = [];
  for (const o of overrides) {
    map.set(o.permission.key, { key: o.permission.key, view: o.canView, edit: o.canEdit, delete: o.canDelete });
    overriddenKeys.push(o.permission.key);
  }
  return { effective: [...map.values()], overriddenKeys, roleId: u.roleId };
}

export async function putUserPermissions(ctx: TenantContext, userId: number, grants: PermissionGrantDto[]): Promise<UserPermissionsDto> {
  if (!(await scopedDb(ctx).user.findUnique({ where: { id: userId } }))) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  const norm = grants.map(normalizeGrant);
  const perms = await prisma.permission.findMany({ where: { key: { in: norm.map((g) => g.key) } } });
  const byKey = new Map(perms.map((p) => [p.key, p]));
  await prisma.$transaction([
    prisma.userPermission.deleteMany({ where: { userId } }),
    prisma.userPermission.createMany({ data: norm.filter((g) => byKey.has(g.key)).map((g) => ({ userId, permissionId: byKey.get(g.key)!.id, canView: g.view, canEdit: g.edit, canDelete: g.delete })) }),
  ]);
  return getUserPermissions(ctx, userId);
}

export async function listRoles(ctx: TenantContext): Promise<RoleDto[]> {
  const roles = await prisma.role.findMany({
    where: { OR: [{ businessId: null }, { businessId: ctx.businessId! }] },
    include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    isSystem: r.isSystem,
    userCount: r._count.users,
    grants: r.permissions.filter((rp) => !rp.permission.isModule).map((rp) => ({ key: rp.permission.key, view: rp.canView, edit: rp.canEdit, delete: rp.canDelete })),
  }));
}

export async function createRole(ctx: TenantContext, name: string): Promise<RoleDto> {
  await assertRoleManager(ctx);
  const role = await prisma.role.create({ data: { businessId: ctx.businessId!, name } });
  return { id: role.id, name: role.name, isSystem: false, userCount: 0, grants: [] };
}

/** Business-owned (non-system) role of the caller's business, or 404/403. */
async function ownRole(ctx: TenantContext, roleId: number) {
  await assertRoleManager(ctx);
  const role = await prisma.role.findFirst({ where: { id: roleId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');
  if (role.isSystem) throw new HttpError(403, 'FORBIDDEN', 'System roles cannot be renamed or deleted');
  return role;
}

export async function renameRole(ctx: TenantContext, roleId: number, name: string): Promise<RoleDto> {
  await ownRole(ctx, roleId);
  const clash = await prisma.role.findFirst({ where: { businessId: ctx.businessId!, name, NOT: { id: roleId } } });
  if (clash) throw new HttpError(409, 'CONFLICT', 'A role with this name already exists');
  await prisma.role.update({ where: { id: roleId }, data: { name } });
  return (await listRoles(ctx)).find((r) => r.id === roleId)!;
}

export async function deleteRole(ctx: TenantContext, roleId: number): Promise<void> {
  await ownRole(ctx, roleId);
  const users = await prisma.user.count({ where: { roleId } });
  if (users) throw new HttpError(409, 'CONFLICT', `Role is assigned to ${users} user(s); move them to another role first`);
  await prisma.$transaction([prisma.rolePermission.deleteMany({ where: { roleId } }), prisma.role.delete({ where: { id: roleId } })]);
}

export async function putRolePermissions(ctx: TenantContext, roleId: number, grants: PermissionGrantDto[]): Promise<RoleDto> {
  await assertRoleManager(ctx);
  const role = await prisma.role.findFirst({ where: { id: roleId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } });
  if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');
  // System roles are templates: reuse this business's copy (by name) or create it, then move this business's users onto the copy.
  let targetId = role.id;
  if (role.isSystem) {
    const copy = (await prisma.role.findFirst({ where: { businessId: ctx.businessId!, name: role.name } })) ?? (await prisma.role.create({ data: { businessId: ctx.businessId!, name: role.name } }));
    await prisma.user.updateMany({ where: { businessId: ctx.businessId!, roleId: role.id }, data: { roleId: copy.id } });
    targetId = copy.id;
  }
  const norm = grants.map(normalizeGrant);
  const perms = await prisma.permission.findMany({ where: { key: { in: norm.map((g) => g.key) } } });
  const byKey = new Map(perms.map((p) => [p.key, p]));
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId: targetId } }),
    prisma.rolePermission.createMany({ data: norm.filter((g) => byKey.has(g.key)).map((g) => ({ roleId: targetId, permissionId: byKey.get(g.key)!.id, canView: g.view, canEdit: g.edit, canDelete: g.delete })) }),
  ]);
  return (await listRoles(ctx)).find((r) => r.id === targetId)!;
}

// ───────────── Business & subscription (owner) ─────────────

export async function getBusiness(ctx: TenantContext): Promise<BusinessProfileDto> {
  const b = await prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId! } });
  return { id: b.id, name: b.name, ownerName: b.ownerName, mobile: b.mobile, alternateMobile: b.alternateMobile, email: b.email, gstin: b.gstin, address: b.address, stateId: b.stateId, districtId: b.districtId };
}

export async function updateBusiness(ctx: TenantContext, body: Record<string, unknown>): Promise<BusinessProfileDto> {
  await prisma.business.update({ where: { id: ctx.businessId! }, data: body });
  return getBusiness(ctx);
}

export async function subscriptionView(ctx: TenantContext): Promise<SubscriptionViewDto> {
  const sub = await prisma.subscription.findFirst({ where: { businessId: ctx.businessId! }, orderBy: { endsAt: 'desc' }, include: { plan: true } });
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'No subscription');
  const [usedBranches, usedUsers] = await Promise.all([
    prisma.branch.count({ where: { businessId: ctx.businessId! } }),
    prisma.user.count({ where: { businessId: ctx.businessId! } }),
  ]);
  const [payments, plans] = await Promise.all([
    prisma.subscriptionPayment.findMany({
      where: { businessId: ctx.businessId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        plan: { select: { name: true, durationDays: true } },
        subscription: { select: { plan: { select: { name: true, durationDays: true } } } },
      },
    }),
    // Only ACTIVE plans are offered; tenants never get the full /platform/plans list.
    prisma.plan.findMany({ where: { isActive: true }, orderBy: [{ price: 'asc' }, { id: 'asc' }] }),
  ]);
  return {
    planName: sub.plan.name,
    planId: sub.planId,
    startsAt: sub.startsAt.toISOString(),
    endsAt: sub.endsAt.toISOString(),
    readOnly: ctx.readOnly,
    maxBranches: sub.maxBranches,
    maxUsers: sub.maxUsers,
    usedBranches,
    usedUsers,
    modules: sub.modules,
    payments: payments.map((p) => {
      // The plan the owner asked for wins; else the plan of the subscription the payment is linked to.
      const plan = p.plan ?? p.subscription?.plan ?? null;
      return {
        id: p.id,
        amount: p.amount.toString(),
        method: p.method as SubscriptionPaymentRowDto['method'],
        utr: p.utr,
        status: p.status,
        paidAt: p.paidAt ? p.paidAt.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
        hasProof: p.screenshotUrl != null,
        planName: plan?.name ?? null,
        planDurationDays: plan?.durationDays ?? null,
      };
    }),
    availablePlans: plans.map((pl) => ({
      id: pl.id,
      name: pl.name,
      description: pl.description,
      durationDays: pl.durationDays,
      price: pl.price.toString(),
      maxBranches: pl.maxBranches,
      maxUsers: pl.maxUsers,
      modules: pl.modules,
    })),
  };
}

export async function recordSubscriptionPayment(ctx: TenantContext, body: { amount: number; method: 'UPI' | 'CASH' | 'BANK' | 'GATEWAY'; utr?: string; paidAt?: Date; subscriptionId?: number; planId?: number }): Promise<{ id: number }> {
  // A requested plan must be one the platform still offers.
  if (body.planId != null && !(await prisma.plan.findFirst({ where: { id: body.planId, isActive: true }, select: { id: true } }))) {
    throw new HttpError(404, 'NOT_FOUND', 'Plan not found');
  }
  // Only this business's own subscription may be referenced (a foreign subscriptionId is ignored).
  const sub = await prisma.subscription.findFirst({
    where: { businessId: ctx.businessId!, ...(body.subscriptionId ? { id: body.subscriptionId } : {}) },
    orderBy: { endsAt: 'desc' },
  });
  const p = await prisma.subscriptionPayment.create({
    data: {
      businessId: ctx.businessId!,
      subscriptionId: sub?.id ?? null,
      amount: body.amount,
      method: body.method,
      utr: body.utr ?? null,
      status: 'PENDING', // owner records; Super Admin confirms
      paidAt: body.paidAt ?? null,
      recordedById: ctx.userId,
      planId: body.planId ?? null,
    },
  });
  return { id: p.id };
}

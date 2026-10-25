import { Prisma } from '@prisma/client';
import type { PermissionEnquiry } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import type { Paged, PermissionEnquiryDto } from '../../shared';

// TASK-87 — Permission enquiries: a store user requests access to a page/action; a manager grants (merge) or rejects.
type EnquiryBody = { permissionKey: string; view: boolean; edit: boolean; delete: boolean; reason?: string };

async function decorate(ctx: TenantContext, rows: PermissionEnquiry[]): Promise<PermissionEnquiryDto[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.decidedById]).filter((x): x is number => x != null))];
  const permIds = [...new Set(rows.map((r) => r.permissionId))];
  const [users, perms] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }),
    prisma.permission.findMany({ where: { id: { in: permIds } }, select: { id: true, key: true, label: true } }),
  ]);
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  const pMap = new Map(perms.map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id,
    user: { id: r.userId, name: uMap.get(r.userId) ?? '' },
    permissionKey: pMap.get(r.permissionId)?.key ?? '',
    permissionLabel: pMap.get(r.permissionId)?.label ?? '',
    view: r.wantView,
    edit: r.wantEdit,
    delete: r.wantDelete,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedById != null ? (uMap.get(r.decidedById) ?? null) : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Staff: raise a request. One PENDING per (user, permission) — serialised with an advisory lock so a double-submit 409s. */
export async function createEnquiry(ctx: TenantContext, body: EnquiryBody): Promise<PermissionEnquiryDto> {
  const perm = await prisma.permission.findUnique({ where: { key: body.permissionKey } });
  if (!perm) throw new HttpError(404, 'NOT_FOUND', 'Permission not found');
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${ctx.userId}::int4, ${perm.id}::int4)`);
    const existing = await tx.permissionEnquiry.findFirst({ where: { businessId: ctx.businessId!, userId: ctx.userId, permissionId: perm.id, status: 'PENDING' } });
    if (existing) throw new HttpError(409, 'CONFLICT', 'You already have a pending request for this permission');
    return tx.permissionEnquiry.create({ data: { businessId: ctx.businessId!, userId: ctx.userId, permissionId: perm.id, wantView: body.view, wantEdit: body.edit, wantDelete: body.delete, reason: body.reason ?? null } });
  });
  return (await decorate(ctx, [created]))[0]!;
}

/** Staff: my own requests, newest first. */
export async function myEnquiries(ctx: TenantContext): Promise<PermissionEnquiryDto[]> {
  const rows = await scopedDb(ctx).permissionEnquiry.findMany({ where: { userId: ctx.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return decorate(ctx, rows);
}

/** Manager: requests whose requester's branch is in the caller's subtree (scopedDb user is branch-scoped). */
export async function listEnquiries(ctx: TenantContext, q: { page: number; pageSize: number; status?: 'PENDING' | 'APPROVED' | 'REJECTED' }): Promise<Paged<PermissionEnquiryDto>> {
  const sdb = scopedDb(ctx);
  const scopeUserIds = (await sdb.user.findMany({ select: { id: true } })).map((u) => u.id);
  if (scopeUserIds.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
  const where = { userId: { in: scopeUserIds }, ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    sdb.permissionEnquiry.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    sdb.permissionEnquiry.count({ where }),
  ]);
  return { items: await decorate(ctx, rows), total, page: q.page, pageSize: q.pageSize };
}

/** Load a PENDING-decidable enquiry + its requester, enforcing scope (business + requester in subtree) and the self/owner guards. */
async function loadForDecision(ctx: TenantContext, id: number): Promise<{ enq: PermissionEnquiry; targetIsOwner: boolean }> {
  const sdb = scopedDb(ctx);
  const enq = await sdb.permissionEnquiry.findUnique({ where: { id } });
  if (!enq) throw new HttpError(404, 'NOT_FOUND', 'Request not found');
  if (enq.userId === ctx.userId) throw new HttpError(403, 'FORBIDDEN', 'You cannot decide your own request');
  const target = await sdb.user.findUnique({ where: { id: enq.userId } }); // branch-scoped → null if outside the caller's subtree
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Request not found');
  if (target.isOwner && !ctx.isOwner) throw new HttpError(403, 'FORBIDDEN', 'Only the owner can grant to the owner');
  return { enq, targetIsOwner: target.isOwner };
}

/** Manager: approve → merge the requested actions into the user's permission override (edit||delete ⇒ view). */
export async function approveEnquiry(ctx: TenantContext, id: number): Promise<PermissionEnquiryDto> {
  const { enq } = await loadForDecision(ctx, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.permissionEnquiry.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', decidedById: ctx.userId, decidedAt: new Date() } });
    if (res.count !== 1) throw new HttpError(409, 'CONFLICT', 'Request already decided');
    const existing = await tx.userPermission.findUnique({ where: { userId_permissionId: { userId: enq.userId, permissionId: enq.permissionId } } });
    const canEdit = (existing?.canEdit ?? false) || enq.wantEdit;
    const canDelete = (existing?.canDelete ?? false) || enq.wantDelete;
    const canView = (existing?.canView ?? false) || enq.wantView || canEdit || canDelete;
    await tx.userPermission.upsert({
      where: { userId_permissionId: { userId: enq.userId, permissionId: enq.permissionId } },
      create: { userId: enq.userId, permissionId: enq.permissionId, canView, canEdit, canDelete },
      update: { canView, canEdit, canDelete },
    });
    await logActivity(tx, ctx, { module: 'ROLES', action: 'EDITED', entity: 'PermissionEnquiry', entityId: String(id), summary: 'Approved access request' });
  });
  return (await decorate(ctx, [await scopedDb(ctx).permissionEnquiry.findUniqueOrThrow({ where: { id } })]))[0]!;
}

/** Manager: reject (no grant). */
export async function rejectEnquiry(ctx: TenantContext, id: number, note?: string): Promise<PermissionEnquiryDto> {
  await loadForDecision(ctx, id);
  const res = await scopedDb(ctx).permissionEnquiry.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', decidedById: ctx.userId, decidedAt: new Date(), decisionNote: note ?? null } });
  if (res.count !== 1) throw new HttpError(409, 'CONFLICT', 'Request already decided');
  return (await decorate(ctx, [await scopedDb(ctx).permissionEnquiry.findUniqueOrThrow({ where: { id } })]))[0]!;
}

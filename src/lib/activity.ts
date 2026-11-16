import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import type { ActivityAction } from '../shared';
import type { TenantContext } from '../middleware/context';

/**
 * One ActivityLog row inside a document tx. Reused by billing, udhar, income/expense and stock
 * so the owner's audit trail is written the same way everywhere.
 */
export interface ActivityInput {
  module: string;
  action: ActivityAction;
  entity: string;
  entityId: string;
  summary: string;
  partyName?: string | null;
  meta?: Prisma.InputJsonValue;
}

export async function logActivity(tx: Prisma.TransactionClient, ctx: TenantContext, a: ActivityInput): Promise<void> {
  // G7 audit M5: a Super Admin acting while impersonating is named in the row, not passed off as the owner's own work
  const meta = ctx.impersonatorId ? { ...((a.meta ?? {}) as Prisma.InputJsonObject), impersonatorId: ctx.impersonatorId } : a.meta;
  await tx.activityLog.create({
    data: {
      businessId: ctx.businessId,
      branchId: ctx.activeBranchId ?? ctx.scopeBranchId,
      userId: ctx.userId,
      module: a.module,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      summary: a.summary,
      partyName: a.partyName ?? null,
      ...(meta !== undefined ? { meta } : {}),
    },
  });
}

/**
 * G7 review 4: one audit row per write a Super Admin made — or tried — while impersonating: userId is the impersonated
 * user, meta.impersonatorId the real actor. Path and status only, never the body (it may hold passwords).
 */
export async function logImpersonatedWrite(r: { businessId: number | null; branchId: number | null; userId: number; impersonatorId: number; method: string; path: string; status: number }): Promise<void> {
  await prisma.activityLog
    .create({
      data: {
        businessId: r.businessId,
        branchId: r.branchId,
        userId: r.userId,
        module: 'IMPERSONATION',
        action: 'EDITED',
        entity: 'Request',
        entityId: `${r.method} ${r.path}`,
        summary: `Super Admin #${r.impersonatorId} acting as user #${r.userId}: ${r.method} ${r.path} → ${r.status}${r.status >= 400 ? ' (refused)' : ''}`,
        meta: { impersonatorId: r.impersonatorId, impersonatedUserId: r.userId, method: r.method, path: r.path, status: r.status },
      },
    })
    .catch((e: unknown) => console.error('[audit] impersonated write not recorded', e));
}

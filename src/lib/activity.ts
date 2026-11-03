import type { Prisma } from '@prisma/client';
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

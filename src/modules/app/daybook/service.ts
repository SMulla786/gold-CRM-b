import { prisma } from '../../../lib/prisma';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';

// TASK-80 — Day-Book open/close per branch+date. Balances stay derived in accounts.getDayBook;
// this only persists the OPEN|CLOSED status and backs the hard-lock guard in lib/ledger.post.
type DayStatus = 'OPEN' | 'CLOSED';
export interface DayStatusDto {
  date: string;
  status: DayStatus;
}

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** Open (= create or reopen to OPEN) or close the active branch's Day-Book for a date. */
async function setDayStatus(ctx: TenantContext, date: Date | undefined, status: DayStatus): Promise<DayStatusDto> {
  const branchId = ctx.activeBranchId ?? ctx.scopeBranchId;
  if (branchId == null || !ctx.branchIds.includes(branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const day = ledger.businessDate(date ?? new Date());
  const stamp = status === 'CLOSED' ? { status, closedAt: new Date(), closedById: ctx.userId } : { status, openedAt: new Date(), openedById: ctx.userId };

  await prisma.$transaction(async (tx) => {
    const row = await tx.dayBook.upsert({
      where: { businessId_branchId_date: { businessId: ctx.businessId!, branchId, date: day } },
      create: { businessId: ctx.businessId!, branchId, date: day, ...stamp },
      update: stamp,
    });
    await logActivity(tx, ctx, { module: 'DAYBOOK', action: 'EDITED', entity: 'DayBook', entityId: String(row.id), summary: `Day-Book ${status === 'CLOSED' ? 'closed' : 'opened'} for ${dateOnly(day)}` });
  });
  return { date: dateOnly(day), status };
}

export const openDay = (ctx: TenantContext, date?: Date): Promise<DayStatusDto> => setDayStatus(ctx, date, 'OPEN');
export const closeDay = (ctx: TenantContext, date?: Date): Promise<DayStatusDto> => setDayStatus(ctx, date, 'CLOSED');

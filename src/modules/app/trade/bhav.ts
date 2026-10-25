import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { bhavBookingBody, bhavListQuery, metalToMoney } from '../../../shared';
import type { BhavBookingDto, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, assertBank, dateOnly, lctxOf, loadRefs, money, moneyRows, nextNo, settingsUnit, wt } from './common';

type BhavBody = z.infer<typeof bhavBookingBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function createBhav(ctx: TenantContext, body: BhavBody): Promise<BhavBookingDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  await assertBank(ctx, body.online, body.bankAccountId);
  const unit = await settingsUnit(ctx, body.metal);
  const amount = D(metalToMoney(body.weight, body.rate, unit));
  const advance = D(body.cash).plus(body.online);

  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  const id = await prisma.$transaction(async (tx) => {
    const bookingNo = await nextNo(tx, ctx.businessId!, branchId, 'BHAV_BOOKING');
    const bk = await tx.bhavBooking.create({
      data: { businessId: ctx.businessId!, branchId, bookingNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate, weight: body.weight, rate: body.rate, amount, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, pendingWeight: body.weight, status: 'PENDING', narration: body.narration ?? null, createdById: ctx.userId },
    });
    const sid = String(bk.id);
    if (advance.gt(0)) {
      await ledger.post(tx, lctx, moneyRows('BHAV_BOOKING', branchId, txnDate, 'IN', body.cash, body.online, body.bankAccountId ?? null, sid, body.partyId, `Bhav booking #${bookingNo} advance`));
      await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate, amount: advance.negated(), source: 'BHAV_BOOKING', sourceId: sid, narration: `Bhav booking #${bookingNo} advance` }]); // party credit until delivered
    }
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'CREATED', entity: 'BHAV_BOOKING', entityId: sid, summary: `Bhav booking #${bookingNo} ${body.side} ${wt(body.weight)}g`, partyName: party.name });
    return bk.id;
  });
  return getBhav(ctx, id);
}

export async function cancelBhav(ctx: TenantContext, id: number): Promise<BhavBookingDto> {
  const sdb = scopedDb(ctx);
  const bk = await sdb.bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  await prisma.$transaction(async (tx) => {
    const upd = await tx.bhavBooking.updateMany({ where: { id, status: { in: ['PENDING', 'PARTIAL'] } }, data: { status: 'CANCELLED' } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking is not open'); // advance stays as the party's credit (refund = a normal udhar entry)
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'EDITED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Cancelled bhav booking #${bk.bookingNo}` });
  });
  return getBhav(ctx, id);
}

export async function deleteBhav(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const bk = await sdb.bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    // Only an untouched PENDING booking (status PENDING ⇒ no delivery, pendingWeight = weight) can be deleted.
    const del = await tx.bhavBooking.deleteMany({ where: { id, status: 'PENDING' } });
    if (del.count !== 1) throw new HttpError(409, 'CONFLICT', 'Only an undelivered booking can be deleted');
    await ledger.reverse(tx, lctx, { source: 'BHAV_BOOKING', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'BHAV_BOOKING', sourceId: String(id) });
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'DELETED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Deleted bhav booking #${bk.bookingNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, bk: any): Promise<BhavBookingDto> {
  const refs = await loadRefs(ctx, bk);
  return {
    id: bk.id, bookingNo: bk.bookingNo, side: bk.side, party: refs.party, branch: refs.branch, metal: bk.metal, txnDate: dateOnly(bk.txnDate),
    weight: wt(bk.weight), rate: money(bk.rate), amount: money(bk.amount), advance: money(D(bk.cash).plus(bk.online)), bankAccount: refs.bankAccount,
    pendingWeight: wt(bk.pendingWeight), status: bk.status, narration: bk.narration, createdBy: refs.createdBy, createdAt: bk.createdAt.toISOString(),
  };
}

export async function getBhav(ctx: TenantContext, id: number): Promise<BhavBookingDto> {
  const bk = await scopedDb(ctx).bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  return toDto(ctx, bk);
}

export async function listBhav(ctx: TenantContext, query: z.infer<typeof bhavListQuery>): Promise<Paged<BhavBookingDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(query.side ? { side: query.side } : {}), ...(query.status ? { status: query.status } : {}), ...(query.partyId ? { partyId: query.partyId } : {}), ...(query.metal ? { metal: query.metal } : {}),
    ...(query.open === 'true' ? { status: { in: ['PENDING', 'PARTIAL'] } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.bhavBooking.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.bhavBooking.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}

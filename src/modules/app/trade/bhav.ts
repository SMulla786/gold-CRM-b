import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { bhavBookingBody, bhavListQuery, metalToMoney } from '../../../shared';
import type { BhavBookingDto, Paged, TradeHistoryDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, docHistory, lctxOf, loadPayments, loadRefs, money, nextNo, payPlan, payRows, savePayments, settingsUnit, snap, userName, wt } from './common';
import type { PayPlan } from './common';

type BhavBody = z.infer<typeof bhavBookingBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * weight / rate / amount of a body. No lines[] → the single weight × rate path exactly as before.
 * lines[] → weight = Σ weight, amount = Σ per-row metalToMoney, rate = Σ(weight × rate) / Σ weight
 * rounded half-up to 2 dp (rates are stored to 2 dp; it is the locked rate a delivery must use).
 */
function figures(body: BhavBody, unit: number) {
  if (!body.lines) return { weight: D(body.weight!), rate: D(body.rate!), amount: D(metalToMoney(body.weight!, body.rate!, unit)), lines: [] as Array<{ weight: number; rate: number; amount: Prisma.Decimal }> };
  const lines = body.lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: D(metalToMoney(l.weight, l.rate, unit)) }));
  const weight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  const amount = lines.reduce((a, l) => a.plus(l.amount), D(0));
  const rate = lines.reduce((a, l) => a.plus(D(l.weight).times(l.rate)), D(0)).div(weight).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { weight, rate, amount, lines };
}

/**
 * Advance, posted once, in the direction the money moves: SELL (the party buys from the shop) → RECEIVED = MONEY IN +
 * party credit; BUY (the shop buys from the party) → GIVEN = MONEY OUT + party debit. The delivering buy-sell posts only
 * its own bill − payments, so booking + delivery net to zero once the rest is settled on delivery (TRD-04).
 * ONLY_ENTRY bookings post nothing (so delete/cancel/edit have nothing to reverse).
 */
export async function postAdvance(tx: Prisma.TransactionClient, ctx: TenantContext, bk: { id: number; bookingNo: number; side: BhavBody['side']; branchId: number; partyId: number; txnDate: Date }, entryType: BhavBody['entryType'], plan: PayPlan) {
  const advance = D(plan.cash).plus(plan.online);
  if (entryType === 'ONLY_ENTRY' || !advance.gt(0)) return;
  const sid = String(bk.id);
  const lctx = lctxOf(ctx);
  const given = bk.side === 'BUY';
  await ledger.post(tx, lctx, payRows(plan, 'BHAV_BOOKING', bk.branchId, bk.txnDate, given ? 'OUT' : 'IN', sid, bk.partyId, `Bhav booking #${bk.bookingNo} advance`));
  await udhar.post(tx, lctx, [{ branchId: bk.branchId, partyId: bk.partyId, txnDate: bk.txnDate, amount: given ? advance : advance.negated(), source: 'BHAV_BOOKING', sourceId: sid, narration: `Bhav booking #${bk.bookingNo} advance` }]); // until delivered
}

export async function createBhav(ctx: TenantContext, body: BhavBody): Promise<BhavBookingDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);
  const f = figures(body, unit);

  const txnDate = ledger.businessDate(body.txnDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    const bookingNo = await nextNo(tx, ctx.businessId!, branchId, 'BHAV_BOOKING');
    const bk = await tx.bhavBooking.create({
      data: {
        businessId: ctx.businessId!, branchId, bookingNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate, weight: f.weight, rate: f.rate, amount: f.amount,
        cash: plan.cash, online: plan.online, bankAccountId: plan.bankAccountId, pendingWeight: f.weight, status: 'PENDING', entryType: body.entryType, narration: body.narration ?? null, createdById: ctx.userId,
        ...(f.lines.length ? { lines: { create: f.lines } } : {}),
      },
    });
    if (plan.rows) await savePayments(tx, ctx, 'BHAV', bk.id, plan);
    await postAdvance(tx, ctx, bk, body.entryType, plan);
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'CREATED', entity: 'BHAV_BOOKING', entityId: String(bk.id), summary: `Bhav booking #${bookingNo} ${body.side} ${wt(f.weight)}g`, partyName: party.name });
    return bk.id;
  });
  return getBhav(ctx, id);
}

/**
 * Edit = reverse the old advance postings exactly as delete does, then post the new body, in one tx; same id + booking no.
 * Only a PENDING booking (nothing delivered against it) is editable. An edit clears the verification stamp.
 */
export async function updateBhav(ctx: TenantContext, id: number, body: BhavBody): Promise<BhavBookingDto> {
  const sdb = scopedDb(ctx);
  const old = await sdb.bhavBooking.findFirst({ where: { id }, include: withLines });
  if (!old) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  if (old.status !== 'PENDING') throw new HttpError(409, 'CONFLICT', 'Only a pending (undelivered) booking can be edited');
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);
  const f = figures(body, unit);
  const txnDate = ledger.businessDate(body.txnDate ?? old.txnDate);
  const lctx = lctxOf(ctx);
  const before = snap({ ...old, payments: await loadPayments(ctx, 'BHAV', id) });

  await prisma.$transaction(async (tx) => {
    const upd = await tx.bhavBooking.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        side: body.side, partyId: body.partyId, metal: body.metal, txnDate, weight: f.weight, rate: f.rate, amount: f.amount, cash: plan.cash, online: plan.online, bankAccountId: plan.bankAccountId,
        pendingWeight: f.weight, entryType: body.entryType, narration: body.narration ?? null, verifiedAt: null, verifiedById: null,
      },
    });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Only a pending (undelivered) booking can be edited');
    await ledger.reverse(tx, lctx, { source: 'BHAV_BOOKING', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'BHAV_BOOKING', sourceId: String(id) });
    await tx.bhavBookingLine.deleteMany({ where: { bookingId: id } });
    if (f.lines.length) await tx.bhavBookingLine.createMany({ data: f.lines.map((l) => ({ bookingId: id, ...l })) });
    await savePayments(tx, ctx, 'BHAV', id, plan);
    await postAdvance(tx, ctx, { id, bookingNo: old.bookingNo, side: body.side, branchId: old.branchId, partyId: body.partyId, txnDate }, body.entryType, plan);
    const after = await tx.bhavBooking.findUniqueOrThrow({ where: { id }, include: withLines });
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'EDITED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Edited bhav booking #${old.bookingNo}`, partyName: party.name, meta: { before, after: snap({ ...after, payments: plan.rows ?? [] }) } });
  });
  return getBhav(ctx, id);
}

export async function cancelBhav(ctx: TenantContext, id: number): Promise<BhavBookingDto> {
  const sdb = scopedDb(ctx);
  const bk = await sdb.bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  await prisma.$transaction(async (tx) => {
    const upd = await tx.bhavBooking.updateMany({ where: { id, status: { in: ['PENDING', 'PARTIAL'] } }, data: { status: 'CANCELLED' } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking is not open'); // the advance stays on the party's account (refund = a normal udhar entry)
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'EDITED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Cancelled bhav booking #${bk.bookingNo}` });
  });
  return getBhav(ctx, id);
}

/** DELIVERED | PARTIAL → PENDING with pendingWeight = weight, only while no buy-sell is linked to the booking. */
export async function undeliverBhav(ctx: TenantContext, id: number): Promise<BhavBookingDto> {
  const sdb = scopedDb(ctx);
  const bk = await sdb.bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  await prisma.$transaction(async (tx) => {
    // a buy-sell holds this booking as its first (bhavBookingId) or as any of its multi-booking deliveries (TRD-03)
    const linked = await tx.buySell.count({ where: { businessId: ctx.businessId!, OR: [{ bhavBookingId: id }, { deliveries: { some: { bookingId: id } } }] } });
    if (linked > 0) throw new HttpError(409, 'CONFLICT', `Booking #${bk.bookingNo} has ${linked} buy-sell ${linked === 1 ? 'entry' : 'entries'} delivered against it. Delete ${linked === 1 ? 'it' : 'them'} first.`);
    const upd = await tx.bhavBooking.updateMany({ where: { id, status: { in: ['DELIVERED', 'PARTIAL'] } }, data: { status: 'PENDING', pendingWeight: bk.weight } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Only a delivered or part-delivered booking can be marked undelivered');
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'EDITED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Marked bhav booking #${bk.bookingNo} undelivered` });
  });
  return getBhav(ctx, id);
}

/** Set (verify) or clear (unverify) the verification stamp. Idempotent: no change → no log row. */
export async function verifyBhav(ctx: TenantContext, id: number, verified: boolean): Promise<BhavBookingDto> {
  const sdb = scopedDb(ctx);
  const bk = await sdb.bhavBooking.findFirst({ where: { id } });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  await prisma.$transaction(async (tx) => {
    const upd = await tx.bhavBooking.updateMany({
      where: { id, verifiedAt: verified ? null : { not: null } },
      data: verified ? { verifiedAt: new Date(), verifiedById: ctx.userId } : { verifiedAt: null, verifiedById: null },
    });
    if (upd.count === 1) await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'EDITED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `${verified ? 'Verified' : 'Removed verification of'} bhav booking #${bk.bookingNo}` });
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
    await savePayments(tx, ctx, 'BHAV', id, null);
    await logActivity(tx, ctx, { module: 'BHAV_BOOKING', action: 'DELETED', entity: 'BHAV_BOOKING', entityId: String(id), summary: `Deleted bhav booking #${bk.bookingNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

const withLines = { lines: { orderBy: { id: 'asc' as const } } };

/**
 * TRD-04: the payments (cash + online, never the bill total) on the buy-sells delivered against each booking. A trade
 * delivered from several bookings shares its payment by each booking's delivered value (weight × booking rate); the last
 * booking takes the rounding remainder so the shares add up to the payment exactly. Pre-TRD-03 trades: all to their one link.
 */
async function settlements(ctx: TenantContext, ids: number[]): Promise<Map<number, Prisma.Decimal>> {
  const out = new Map<number, Prisma.Decimal>();
  if (!ids.length) return out;
  const sdb = scopedDb(ctx);
  const trades = await sdb.buySell.findMany({
    where: { OR: [{ bhavBookingId: { in: ids } }, { deliveries: { some: { bookingId: { in: ids } } } }] },
    select: { cash: true, online: true, bhavBookingId: true, deliveries: { orderBy: { bookingId: 'asc' }, select: { bookingId: true, weight: true } } },
  });
  const rates = new Map((await sdb.bhavBooking.findMany({ where: { id: { in: [...new Set(trades.flatMap((t) => t.deliveries.map((d) => d.bookingId)))] } }, select: { id: true, rate: true } })).map((b) => [b.id, D(b.rate)]));
  const add = (id: number, v: Prisma.Decimal) => out.set(id, (out.get(id) ?? D(0)).plus(v));
  for (const t of trades) {
    const paid = D(t.cash).plus(t.online);
    if (!t.deliveries.length) { add(t.bhavBookingId!, paid); continue; }
    const value = t.deliveries.map((d) => D(d.weight).times(rates.get(d.bookingId)!));
    const total = value.reduce((a, v) => a.plus(v), D(0));
    let left = paid;
    t.deliveries.forEach((d, i) => {
      const share = i === t.deliveries.length - 1 ? left : paid.times(value[i]!).div(total).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      left = left.minus(share);
      add(d.bookingId, share);
    });
  }
  return out;
}

async function toDto(ctx: TenantContext, bk: any, settled?: Map<number, Prisma.Decimal>): Promise<BhavBookingDto> {
  settled ??= await settlements(ctx, [bk.id]);
  const [refs, payments, verifiedBy] = await Promise.all([loadRefs(ctx, bk), loadPayments(ctx, 'BHAV', bk.id), userName(ctx, bk.verifiedById ?? null)]);
  return {
    id: bk.id, bookingNo: bk.bookingNo, side: bk.side, party: refs.party, branch: refs.branch, metal: bk.metal, txnDate: dateOnly(bk.txnDate),
    weight: wt(bk.weight), rate: money(bk.rate), amount: money(bk.amount), advance: money(D(bk.cash).plus(bk.online)), bankAccount: refs.bankAccount,
    pendingWeight: wt(bk.pendingWeight), status: bk.status, narration: bk.narration, createdBy: refs.createdBy, createdAt: bk.createdAt.toISOString(),
    cash: money(bk.cash), online: money(bk.online), entryType: bk.entryType, verifiedAt: bk.verifiedAt ? bk.verifiedAt.toISOString() : null, verifiedBy,
    lines: (bk.lines ?? []).map((l: any) => ({ id: l.id, weight: wt(l.weight), rate: money(l.rate), amount: money(l.amount) })), payments,
    settlement: money(settled.get(bk.id) ?? D(0)),
  };
}

export async function getBhav(ctx: TenantContext, id: number): Promise<BhavBookingDto> {
  const bk = await scopedDb(ctx).bhavBooking.findFirst({ where: { id }, include: withLines });
  if (!bk) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  return toDto(ctx, bk);
}

export async function bhavHistory(ctx: TenantContext, id: number): Promise<TradeHistoryDto[]> {
  if (!(await scopedDb(ctx).bhavBooking.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  return docHistory(ctx, 'BHAV_BOOKING', id);
}

export async function listBhav(ctx: TenantContext, query: z.infer<typeof bhavListQuery>): Promise<Paged<BhavBookingDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(query.side ? { side: query.side } : {}), ...(query.status ? { status: query.status } : {}), ...(query.partyId ? { partyId: query.partyId } : {}), ...(query.metal ? { metal: query.metal } : {}),
    ...(query.open === 'true' ? { status: { in: ['PENDING', 'PARTIAL'] } } : {}),
    ...(query.closed === 'true' ? { status: { in: ['DELIVERED', 'CANCELLED'] } } : {}),
    ...dateRange(query),
  };
  if (query.q) {
    // Same as listExchange: match party name/mobile, or the booking number.
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    const asNo = Number(query.q);
    where.OR = [...(Number.isInteger(asNo) && asNo > 0 && asNo <= 2_147_483_647 ? [{ bookingNo: asNo }] : []), { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.bhavBooking.findMany({ where, include: withLines, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.bhavBooking.count({ where }),
  ]);
  const settled = await settlements(ctx, rows.map((r) => r.id));
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r, settled))), total, page: query.page, pageSize: query.pageSize };
}

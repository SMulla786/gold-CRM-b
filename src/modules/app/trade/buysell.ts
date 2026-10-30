import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { buySellBody, buySellListQuery, metalToMoney } from '../../../shared';
import type { BuySellDto, Paged, TradeHistoryDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, docHistory, lctxOf, loadPayments, loadRefs, lockDoc, metalRow, money, nextNo, payPlan, payRows, savePayments, settingsUnit, snap, wt } from './common';
import { poolGuard } from '../../../lib/kacha';
import { checkInlineUdhar, inlineUdharDto, syncInlineUdhar } from '../udhar';

type BuySellBody = z.infer<typeof buySellBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

/** TRD-03: one booking a trade delivers against (sorted by booking id = the order rows are locked in). */
type Delivery = { bookingId: number; bookingNo: number; rate: Prisma.Decimal; weight: Prisma.Decimal };

/** Σ weight per rate (2 dp key): a trade's lines vs the bookings it delivers from. */
const byRate = (rows: { rate: Prisma.Decimal.Value; weight: Prisma.Decimal.Value }[]) => {
  const m = new Map<string, Prisma.Decimal>();
  for (const r of rows) m.set(D(r.rate).toFixed(2), (m.get(D(r.rate).toFixed(2)) ?? D(0)).plus(r.weight));
  return m;
};
const sameWeights = (a: Map<string, Prisma.Decimal>, b: Map<string, Prisma.Decimal>) => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.toFixed(3) === v.toFixed(3));

/**
 * TRD-03: the bookings a trade delivers against. `bhavBookingId` (one booking, the whole trade weight) and `deliveries`
 * (several) are the same rule: each booking is this branch's, same party / metal / side; and per rate the lines' weight
 * equals the weight taken from bookings at that rate — i.e. every line is at a booking rate and no part of it is undelivered.
 * Pending weight and status are checked again, atomically, when the weight is taken (takeFromBookings).
 */
async function checkDeliveries(ctx: TenantContext, branchId: number, body: BuySellBody, lines: { rate: number; weight: number }[], totalWeight: Prisma.Decimal): Promise<Delivery[]> {
  const asked = body.deliveries ?? (body.bhavBookingId != null ? [{ bookingId: body.bhavBookingId, weight: totalWeight }] : []);
  if (!asked.length) return [];
  const books = await scopedDb(ctx).bhavBooking.findMany({ where: { id: { in: asked.map((d) => d.bookingId) } } });
  const out = asked.map((d) => {
    const b = books.find((x) => x.id === d.bookingId);
    if (!b || b.branchId !== branchId) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    if (b.partyId !== body.partyId || b.metal !== body.metal || b.side !== body.side) throw new HttpError(400, 'VALIDATION', 'Booking does not match this trade');
    return { bookingId: b.id, bookingNo: b.bookingNo, rate: D(b.rate), weight: D(d.weight) };
  });
  if (!sameWeights(byRate(lines), byRate(out))) {
    throw new HttpError(400, 'VALIDATION', asked.length === 1 ? 'Every line must be at the booking rate' : 'Each line must be at a booking rate, and the weight taken from bookings at that rate must equal the lines at that rate');
  }
  return out.sort((a, b) => a.bookingId - b.bookingId);
}

/** Validate a body and work out its figures (shared by create and edit). */
async function prepare(ctx: TenantContext, body: BuySellBody, branchId: number) {
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);

  const lines = body.lines.map((l) => ({ ...l, amount: D(metalToMoney(l.weight, l.rate, unit)) }));
  const totalWeight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  const totalAmount = lines.reduce((a, l) => a.plus(l.amount), D(0)).minus(body.discount);
  const deliveries = await checkDeliveries(ctx, branchId, body, body.lines, totalWeight);
  if (body.udhar) await checkInlineUdhar(ctx, body.partyId, body.udhar);
  return { party, plan, lines, totalWeight, totalAmount, deliveries };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** Take the delivered weight off one booking (atomic; must still be open and have enough pending). */
async function takeFromBooking(tx: Prisma.TransactionClient, bookingId: number, weight: Prisma.Decimal) {
  const dec = await tx.bhavBooking.updateMany({ where: { id: bookingId, status: { in: ['PENDING', 'PARTIAL'] }, pendingWeight: { gte: weight } }, data: { pendingWeight: { decrement: weight } } });
  if (dec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking is not open or lacks the pending weight');
  const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: bookingId } });
  await tx.bhavBooking.update({ where: { id: bookingId }, data: { status: D(fresh.pendingWeight).isZero() ? 'DELIVERED' : 'PARTIAL' } });
}

/** Give delivered weight back to one booking. Atomic increment (not read-then-write) so concurrent deletes don't lose a restore. */
async function giveBackToBooking(tx: Prisma.TransactionClient, bookingId: number, weight: Prisma.Decimal) {
  const rec = await tx.bhavBooking.updateMany({ where: { id: bookingId, status: { not: 'CANCELLED' } }, data: { pendingWeight: { increment: weight } } });
  if (rec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking was cancelled; cannot restore pending weight');
  const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: bookingId } });
  await tx.bhavBooking.update({ where: { id: bookingId }, data: { status: D(fresh.pendingWeight).equals(fresh.weight) ? 'PENDING' : 'PARTIAL' } });
}

/** Take from every booking (id order) and record the allocation rows. */
async function deliver(tx: Prisma.TransactionClient, buySellId: number, deliveries: Delivery[]) {
  for (const d of deliveries) await takeFromBooking(tx, d.bookingId, d.weight);
  if (deliveries.length) await tx.buySellBhavDelivery.createMany({ data: deliveries.map((d) => ({ buySellId, bookingId: d.bookingId, weight: d.weight })) });
}

/** What a saved trade took from its bookings: its allocation rows, or (pre-TRD-03) the single link for the whole weight. */
async function takenFrom(tx: Prisma.TransactionClient, bs: { id: number; bhavBookingId: number | null; totalWeight: Prisma.Decimal }) {
  const rows = await tx.buySellBhavDelivery.findMany({ where: { buySellId: bs.id }, orderBy: { bookingId: 'asc' } });
  if (rows.length) return rows.map((r) => ({ bookingId: r.bookingId, weight: D(r.weight) }));
  return bs.bhavBookingId != null ? [{ bookingId: bs.bhavBookingId, weight: D(bs.totalWeight) }] : [];
}

/** Ledger + udhar postings of a trade (create and the re-post half of an edit). */
async function post(tx: Prisma.TransactionClient, ctx: TenantContext, doc: { id: number; buySellNo: number; branchId: number; txnDate: Date }, body: BuySellBody, p: Prepared) {
  const lctx = lctxOf(ctx);
  const buyIn = body.side === 'BUY'; // shop buys bullion in, pays out
  const sid = String(doc.id);
  const rows = [metalRow('BUY_SELL', doc.branchId, doc.txnDate, buyIn ? 'IN' : 'OUT', body.metal, 'BULLION', p.totalWeight, p.totalWeight, sid, body.partyId, `Buy-sell #${doc.buySellNo}`)];
  rows.push(...payRows(p.plan, 'BUY_SELL', doc.branchId, doc.txnDate, buyIn ? 'OUT' : 'IN', sid, body.partyId, `Buy-sell #${doc.buySellNo}`));
  await ledger.post(tx, lctx, rows);
  const remaining = p.totalAmount.minus(p.plan.cash).minus(p.plan.online);
  if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, amount: buyIn ? remaining.negated() : remaining, source: 'BUY_SELL', sourceId: sid, narration: `Buy-sell #${doc.buySellNo}` }]);
}

/** Reverse a trade's postings and give its weight back to every booking it delivered against (delete and the undo half of an edit). */
async function unpost(tx: Prisma.TransactionClient, ctx: TenantContext, bs: { id: number; bhavBookingId: number | null; totalWeight: Prisma.Decimal }) {
  const lctx = lctxOf(ctx);
  await ledger.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(bs.id) });
  await udhar.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(bs.id) });
  for (const d of await takenFrom(tx, bs)) await giveBackToBooking(tx, d.bookingId, d.weight);
  await tx.buySellBhavDelivery.deleteMany({ where: { buySellId: bs.id } });
}

export async function createBuySell(ctx: TenantContext, body: BuySellBody): Promise<BuySellDto> {
  const branchId = activeBranch(ctx);
  const p = await prepare(ctx, body, branchId);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    // G5 lock order: pools first (a SELL can't sell bullion the branch doesn't hold), then the bookings' rows (id order)
    const pools = await poolGuard(tx, branchId, [{ metal: body.metal, form: 'BULLION' }]);
    const buySellNo = await nextNo(tx, ctx.businessId!, branchId, 'BUY_SELL');
    const inline = await syncInlineUdhar(tx, ctx, null, body.udhar, { branchId, partyId: body.partyId, txnDate }, `Buy-sell #${buySellNo}`);
    const bs = await tx.buySell.create({
      data: {
        businessId: ctx.businessId!, branchId, buySellNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate, totalWeight: p.totalWeight, discount: body.discount, totalAmount: p.totalAmount,
        cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, bhavBookingId: p.deliveries[0]?.bookingId ?? null, narration: body.narration ?? null, createdById: ctx.userId,
        ...inline,
        lines: { create: p.lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: l.amount })) },
      },
    });
    await deliver(tx, bs.id, p.deliveries);
    if (p.plan.rows) await savePayments(tx, ctx, 'BUY_SELL', bs.id, p.plan);
    await post(tx, ctx, { id: bs.id, buySellNo, branchId, txnDate }, body, p);
    await pools();
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'CREATED', entity: 'BUY_SELL', entityId: String(bs.id), summary: `Buy-sell #${buySellNo} ${body.side} ${wt(p.totalWeight)}g`, partyName: p.party.name });
    return bs.id;
  });
  return getBuySell(ctx, id);
}

/**
 * Edit = unpost exactly as delete does (reverse ledger/udhar, give the weight back to the old bookings), then post the
 * new body (take from the new bookings) in ONE tx; same id + trade no. Rejected (409) when a booking it delivered against
 * was cancelled — the same rule delete applies — since that pending weight can't be restored. The inline udhar keeps its
 * udhar no. (re-posted), is created, or is removed, with the trade.
 */
export async function updateBuySell(ctx: TenantContext, id: number, body: BuySellBody): Promise<BuySellDto> {
  const sdb = scopedDb(ctx);
  const old = await sdb.buySell.findFirst({ where: { id }, include: { deliveries: true } });
  if (!old) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  const oldBookings = old.deliveries.length ? old.deliveries.map((d) => d.bookingId) : old.bhavBookingId != null ? [old.bhavBookingId] : [];
  if (oldBookings.length && (await sdb.bhavBooking.count({ where: { id: { in: oldBookings }, status: 'CANCELLED' } })) > 0) {
    throw new HttpError(409, 'CONFLICT', 'The linked bhav booking was cancelled; this trade can no longer be edited');
  }
  const p = await prepare(ctx, body, old.branchId);

  await prisma.$transaction(async (tx) => {
    // G5 lock order: the trade row first (a concurrent edit / delete waits; its rows are reversed once), then the pools
    await lockDoc(tx, 'BuySell', id, ctx.businessId!);
    const old = await tx.buySell.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
    const txnDate = ledger.businessDate(body.txnDate ?? old.txnDate);
    const before = snap({ ...old, payments: await loadPayments(ctx, 'BUY_SELL', id) });
    const pools = await poolGuard(tx, old.branchId, [{ metal: old.metal, form: 'BULLION' }, { metal: body.metal, form: 'BULLION' }]);
    await unpost(tx, ctx, old);
    await deliver(tx, id, p.deliveries);

    const inline = await syncInlineUdhar(tx, ctx, old.inlineUdhar, body.udhar, { branchId: old.branchId, partyId: body.partyId, txnDate }, `Buy-sell #${old.buySellNo}`);
    await tx.buySellLine.deleteMany({ where: { buySellId: id } });
    const after = await tx.buySell.update({
      where: { id },
      data: {
        side: body.side, partyId: body.partyId, metal: body.metal, txnDate, totalWeight: p.totalWeight, discount: body.discount, totalAmount: p.totalAmount,
        cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, bhavBookingId: p.deliveries[0]?.bookingId ?? null, narration: body.narration ?? null,
        ...inline,
        lines: { create: p.lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: l.amount })) },
      },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    await savePayments(tx, ctx, 'BUY_SELL', id, p.plan);
    await post(tx, ctx, { id, buySellNo: old.buySellNo, branchId: old.branchId, txnDate }, body, p);
    await pools();
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'EDITED', entity: 'BUY_SELL', entityId: String(id), summary: `Edited buy-sell #${old.buySellNo}`, partyName: p.party.name, meta: { before, after: snap({ ...after, payments: p.plan.rows ?? [] }) } });
  });
  return getBuySell(ctx, id);
}

export async function deleteBuySell(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  if (!(await sdb.buySell.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  await prisma.$transaction(async (tx) => {
    await lockDoc(tx, 'BuySell', id, ctx.businessId!);
    const bs = await tx.buySell.findUniqueOrThrow({ where: { id } });
    const pools = await poolGuard(tx, bs.branchId, [{ metal: bs.metal, form: 'BULLION' }]); // deleting a BUY takes its bullion back
    await unpost(tx, ctx, bs);
    await syncInlineUdhar(tx, ctx, bs.inlineUdhar, undefined, { branchId: bs.branchId, partyId: bs.partyId, txnDate: bs.txnDate }, '');
    await pools();
    await tx.buySell.delete({ where: { id } }); // lines (allocation rows were released + removed by unpost)
    await savePayments(tx, ctx, 'BUY_SELL', id, null);
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'DELETED', entity: 'BUY_SELL', entityId: String(id), summary: `Deleted buy-sell #${bs.buySellNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, bs: any): Promise<BuySellDto> {
  const sdb = scopedDb(ctx);
  const [refs, payments, udharDto] = await Promise.all([loadRefs(ctx, bs), loadPayments(ctx, 'BUY_SELL', bs.id), inlineUdharDto(ctx, bs.inlineUdhar)]);
  const taken: { bookingId: number; weight: Prisma.Decimal.Value }[] = bs.deliveries?.length ? bs.deliveries : bs.bhavBookingId != null ? [{ bookingId: bs.bhavBookingId, weight: bs.totalWeight }] : [];
  const books = taken.length ? await sdb.bhavBooking.findMany({ where: { id: { in: taken.map((d) => d.bookingId) } }, select: { id: true, bookingNo: true, rate: true } }) : [];
  const deliveries = taken.flatMap((d) => {
    const b = books.find((x) => x.id === d.bookingId);
    return b ? [{ bookingId: b.id, bookingNo: b.bookingNo, rate: money(D(b.rate)), weight: wt(D(d.weight)) }] : [];
  });
  const first = deliveries.find((d) => d.bookingId === bs.bhavBookingId);
  const bal = D(bs.totalAmount).minus(bs.cash).minus(bs.online);
  return {
    id: bs.id, buySellNo: bs.buySellNo, side: bs.side, party: refs.party, branch: refs.branch, metal: bs.metal, txnDate: dateOnly(bs.txnDate),
    totalWeight: wt(bs.totalWeight), discount: money(bs.discount), totalAmount: money(bs.totalAmount), cash: money(bs.cash), online: money(bs.online), bankAccount: refs.bankAccount,
    balance: money(bs.side === 'BUY' ? bal.negated() : bal), bhavBooking: first ? { id: first.bookingId, bookingNo: first.bookingNo } : null, deliveries, udhar: udharDto, narration: bs.narration,
    lines: bs.lines.map((l: any) => ({ id: l.id, weight: wt(l.weight), rate: money(l.rate), amount: money(l.amount) })),
    createdBy: refs.createdBy, createdAt: bs.createdAt.toISOString(), payments,
  };
}

const INCLUDE = { lines: { orderBy: { id: 'asc' as const } }, deliveries: { orderBy: { bookingId: 'asc' as const } } };

export async function getBuySell(ctx: TenantContext, id: number): Promise<BuySellDto> {
  const bs = await scopedDb(ctx).buySell.findFirst({ where: { id }, include: INCLUDE });
  if (!bs) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  return toDto(ctx, bs);
}

export async function buySellHistory(ctx: TenantContext, id: number): Promise<TradeHistoryDto[]> {
  if (!(await scopedDb(ctx).buySell.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  return docHistory(ctx, 'BUY_SELL', id);
}

export async function listBuySell(ctx: TenantContext, query: z.infer<typeof buySellListQuery>): Promise<Paged<BuySellDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.side ? { side: query.side } : {}), ...(query.metal ? { metal: query.metal } : {}), ...(query.partyId ? { partyId: query.partyId } : {}), ...dateRange(query) };
  if (query.q) {
    // Same as listExchange: match party name/mobile, or the trade number.
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    const asNo = Number(query.q);
    where.OR = [...(Number.isInteger(asNo) && asNo > 0 && asNo <= 2_147_483_647 ? [{ buySellNo: asNo }] : []), { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.buySell.findMany({ where, include: INCLUDE, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.buySell.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}

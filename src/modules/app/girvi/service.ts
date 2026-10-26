import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { girviBody, girviInterest, girviReleaseBody } from '../../../shared';
import type { GirviBatchDto, GirviItemDto, GirviListItemDto, GirviTxnDto, Paged, PartyRefDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';

type GirviBody = z.infer<typeof girviBody>;
type GirviReleaseBody = z.infer<typeof girviReleaseBody>;

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const money = (d: unknown) => D(d).toFixed(2);
const wt = (d: unknown) => D(d).toFixed(3);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for girvi (set X-Branch-Id)');
  return ctx.activeBranchId;
}
const addMonths = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
};

/** Interest due on a batch's outstanding principal from interestFrom up to `to` — always via the shared calc, never re-implemented. */
const dueOf = (b: { principal: unknown; ratePercent: unknown; ratePeriod: any; interestType: any; ciPeriod: any; method: any; interestFrom: Date }, to: Date): string =>
  girviInterest({ principal: b.principal as any, ratePercent: b.ratePercent as any, ratePeriod: b.ratePeriod, interestType: b.interestType, ciPeriod: b.ciPeriod ?? undefined, method: b.method, from: dateOnly(b.interestFrom), to: dateOnly(to) }).interest;

/** MONEY ledger rows for a girvi cash/online movement (OUT = paid to customer, IN = received). source GIRVI, sourceId = batch id. */
function girviMoneyRows(branchId: number, txnDate: Date, direction: 'IN' | 'OUT', cash: number, online: number, bankAccountId: number | null, batchId: number, narration: string): ledger.LedgerEntryInput[] {
  const rows: ledger.LedgerEntryInput[] = [];
  if (cash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, amount: cash, source: 'GIRVI', sourceId: String(batchId), narration });
  if (online > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, bankAccountId, amount: online, source: 'GIRVI', sourceId: String(batchId), narration });
  return rows;
}
const assertBank = async (ctx: TenantContext, online: number, bankAccountId?: number) => {
  if (online > 0 && !(await scopedDb(ctx).bankAccount.findUnique({ where: { id: bankAccountId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
};

export async function createGirvi(ctx: TenantContext, body: GirviBody): Promise<GirviBatchDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  await assertBank(ctx, body.online, body.bankAccountId);

  const items = body.items.map((it) => {
    const fine = D(it.net).times(it.purity).div(100);
    return { ...it, fine, valuation: fine.times(it.rate) };
  });
  const valuation = items.reduce((a, i) => a.plus(i.valuation), new Prisma.Decimal(0));
  if (D(body.principal).gt(valuation)) throw new HttpError(400, 'VALIDATION', 'Loan cannot exceed the item valuation');

  const issueDate = ledger.businessDate(body.issueDate ?? new Date());
  const returnDate = addMonths(issueDate, body.tenureMonths);
  const lctx = lctxOf(ctx);

  const id = await prisma.$transaction(async (tx) => {
    const seqRow = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, 'GIRVI', 2)
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const girviNo = Number(seqRow[0]!.next) - 1;
    const batch = await tx.girviBatch.create({
      data: {
        businessId: ctx.businessId!, branchId, girviNo, partyId: body.partyId, issueDate, tenureMonths: body.tenureMonths, returnDate,
        ratePercent: body.ratePercent, ratePeriod: body.ratePeriod, interestType: body.interestType, ciPeriod: body.ciPeriod ?? null, method: body.method,
        valuation, principal: body.principal, interestFrom: issueDate, status: 'ACTIVE', remark: body.remark ?? null, createdById: ctx.userId,
      },
    });
    for (const it of items) await tx.girviItem.create({ data: { batchId: batch.id, category: it.category, name: it.name, gross: it.gross, net: it.net, purity: it.purity, fine: it.fine, rate: it.rate, valuation: it.valuation, status: 'PLEDGED' } });
    await tx.girviTxn.create({ data: { batchId: batch.id, type: 'GRANT', txnDate: issueDate, principal: body.principal, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, createdById: ctx.userId } });
    await ledger.post(tx, lctx, girviMoneyRows(branchId, issueDate, 'OUT', body.cash, body.online, body.bankAccountId ?? null, batch.id, `Girvi #${girviNo} grant`));
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'CREATED', entity: 'GIRVI', entityId: String(batch.id), summary: `Girvi #${girviNo} ₹${body.principal}`, partyName: party.name });
    return batch.id;
  });
  return getGirvi(ctx, id, new Date());
}

export async function payInterest(ctx: TenantContext, id: number, body: { txnDate?: Date; interest: number; discount: number; cash: number; online: number; bankAccountId?: number }): Promise<GirviBatchDto> {
  const sdb = scopedDb(ctx);
  const batch = await sdb.girviBatch.findFirst({ where: { id } });
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Girvi not found');
  if (batch.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
  await assertBank(ctx, body.online, body.bankAccountId);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.girviBatch.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
    const due = dueOf(fresh, txnDate);
    if (D(body.interest).plus(body.discount).gt(due)) throw new HttpError(400, 'VALIDATION', 'Interest paid exceeds the due', { due });
    await tx.girviTxn.create({ data: { batchId: id, type: 'INTEREST', txnDate, interest: body.interest, discount: body.discount, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, createdById: ctx.userId } });
    const rows = girviMoneyRows(fresh.branchId, txnDate, 'IN', body.cash, body.online, body.bankAccountId ?? null, id, `Girvi #${fresh.girviNo} interest`);
    if (rows.length) await ledger.post(tx, lctx, rows);
    if (D(body.interest).plus(body.discount).equals(due)) await tx.girviBatch.update({ where: { id }, data: { interestFrom: txnDate } }); // settled to date — accrue from here
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'EDITED', entity: 'GIRVI', entityId: String(id), summary: `Girvi #${fresh.girviNo} interest ₹${body.interest}` });
  });
  return getGirvi(ctx, id, new Date());
}

export async function topupGirvi(ctx: TenantContext, id: number, body: { txnDate?: Date; principal: number; cash: number; online: number; bankAccountId?: number }): Promise<GirviBatchDto> {
  const sdb = scopedDb(ctx);
  const batch = await sdb.girviBatch.findFirst({ where: { id } });
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Girvi not found');
  if (batch.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
  await assertBank(ctx, body.online, body.bankAccountId);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.girviBatch.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
    if (D(dueOf(fresh, txnDate)).gt(0)) throw new HttpError(409, 'CONFLICT', 'Pay interest up to date before a top-up');
    await tx.girviTxn.create({ data: { batchId: id, type: 'TOPUP', txnDate, principal: body.principal, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, createdById: ctx.userId } });
    await ledger.post(tx, lctx, girviMoneyRows(fresh.branchId, txnDate, 'OUT', body.cash, body.online, body.bankAccountId ?? null, id, `Girvi #${fresh.girviNo} top-up`));
    await tx.girviBatch.update({ where: { id }, data: { principal: { increment: body.principal }, interestFrom: txnDate } });
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'EDITED', entity: 'GIRVI', entityId: String(id), summary: `Girvi #${fresh.girviNo} top-up ₹${body.principal}` });
  });
  return getGirvi(ctx, id, new Date());
}

export async function releaseGirvi(ctx: TenantContext, id: number, body: GirviReleaseBody): Promise<GirviBatchDto> {
  const sdb = scopedDb(ctx);
  const batch = await sdb.girviBatch.findFirst({ where: { id } });
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Girvi not found');
  if (batch.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
  await assertBank(ctx, body.online, body.bankAccountId);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const itemIds = [...new Set(body.itemIds)];
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.girviBatch.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Girvi is not active');
    const due = dueOf(fresh, txnDate);
    if (!D(body.interestPaid).plus(body.discount).equals(due)) throw new HttpError(400, 'VALIDATION', 'Settle the exact interest due to release', { due });
    if (D(body.principalPaid).gt(fresh.principal)) throw new HttpError(400, 'VALIDATION', 'Principal paid exceeds the outstanding loan');
    const pledgedTotal = await tx.girviItem.count({ where: { batchId: id, status: 'PLEDGED' } });

    // Guard first (all itemIds must be PLEDGED in this batch) so a double-release is a 409, not a stale isLast 400.
    const upd = await tx.girviItem.updateMany({ where: { id: { in: itemIds }, batchId: id, status: 'PLEDGED' }, data: { status: 'RELEASED', releasedAt: txnDate } });
    if (upd.count !== itemIds.length) throw new HttpError(409, 'CONFLICT', 'An item is not pledged in this girvi');
    const isLast = itemIds.length === pledgedTotal; // all remaining pledged items released
    if (isLast && !D(body.principalPaid).equals(fresh.principal)) throw new HttpError(400, 'VALIDATION', 'Releasing the last items needs the full principal');
    await tx.girviTxn.create({ data: { batchId: id, type: 'RELEASE', txnDate, principal: body.principalPaid, interest: body.interestPaid, discount: body.discount, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, itemIds, createdById: ctx.userId } });
    const rows = girviMoneyRows(fresh.branchId, txnDate, 'IN', body.cash, body.online, body.bankAccountId ?? null, id, `Girvi #${fresh.girviNo} release`);
    if (rows.length) await ledger.post(tx, lctx, rows);
    await tx.girviBatch.update({ where: { id }, data: { principal: { decrement: body.principalPaid }, interestFrom: txnDate, ...(isLast ? { status: 'CLOSED', closedAt: new Date() } : {}) } });
    await logActivity(tx, ctx, { module: 'GIRVI', action: isLast ? 'DELETED' : 'EDITED', entity: 'GIRVI', entityId: String(id), summary: `Girvi #${fresh.girviNo} release` });
  });
  return getGirvi(ctx, id, new Date());
}

export async function deleteGirvi(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const batch = await sdb.girviBatch.findFirst({ where: { id }, include: { txns: { select: { type: true } } } });
  if (!batch) throw new HttpError(404, 'NOT_FOUND', 'Girvi not found');
  if (batch.txns.length !== 1 || batch.txns[0]!.type !== 'GRANT') throw new HttpError(409, 'CONFLICT', 'Only a girvi with just the grant can be deleted');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    await ledger.reverse(tx, lctx, { source: 'GIRVI', sourceId: String(id) });
    await tx.girviBatch.delete({ where: { id } }); // cascades items + txns
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'DELETED', entity: 'GIRVI', entityId: String(id), summary: `Deleted girvi #${batch.girviNo}` });
  });
}

// ───────────── DTO mappers + list/get ─────────────

const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });
const itemDto = (i: any): GirviItemDto => ({ id: i.id, category: i.category, name: i.name, photoUrl: i.photoUrl, gross: wt(i.gross), net: wt(i.net), purity: String(i.purity), fine: wt(i.fine), rate: money(i.rate), valuation: money(i.valuation), status: i.status, releasedAt: i.releasedAt ? dateOnly(i.releasedAt) : null });
const txnDto = (t: any, baMap: Map<number, string>, uMap: Map<number, string>): GirviTxnDto => ({
  id: t.id, type: t.type, txnDate: dateOnly(t.txnDate), principal: money(t.principal), interest: money(t.interest), discount: money(t.discount), cash: money(t.cash), online: money(t.online),
  bankAccount: t.bankAccountId != null ? { id: t.bankAccountId, name: baMap.get(t.bankAccountId) ?? '' } : null, itemIds: t.itemIds, remark: t.remark,
  createdBy: t.createdById != null ? (uMap.get(t.createdById) ?? null) : null, createdAt: t.createdAt.toISOString(),
});

async function userNames(ctx: TenantContext, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => x != null))];
  if (!uniq.length) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: uniq }, businessId: ctx.businessId! }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

export async function getGirvi(ctx: TenantContext, id: number, asOf: Date): Promise<GirviBatchDto> {
  const sdb = scopedDb(ctx);
  const b = await sdb.girviBatch.findFirst({ where: { id }, include: { items: { orderBy: { id: 'asc' } }, txns: { orderBy: { id: 'asc' } } } });
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Girvi not found');
  const party = await sdb.party.findUnique({ where: { id: b.partyId } });
  const branch = await sdb.branch.findUnique({ where: { id: b.branchId }, select: { name: true } });
  const baIds = [...new Set(b.txns.map((t) => t.bankAccountId).filter((x): x is number => x != null))];
  const baMap = new Map((baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : []).map((x) => [x.id, x.bankName]));
  const uMap = await userNames(ctx, b.txns.map((t) => t.createdById));
  const onDate = ledger.businessDate(asOf);
  const interestDue = dueOf(b, onDate);
  return {
    id: b.id, girviNo: b.girviNo, party: partyRef(party), branch: { id: b.branchId, name: branch?.name ?? '' },
    issueDate: dateOnly(b.issueDate), returnDate: dateOnly(b.returnDate), tenureMonths: b.tenureMonths, ratePercent: String(b.ratePercent), ratePeriod: b.ratePeriod,
    interestType: b.interestType, ciPeriod: b.ciPeriod, method: b.method, valuation: money(b.valuation), principal: money(b.principal), interestFrom: dateOnly(b.interestFrom),
    interestDue, payable: D(b.principal).plus(interestDue).toFixed(2), overdue: b.status === 'ACTIVE' && onDate.getTime() > b.returnDate.getTime(),
    status: b.status, remark: b.remark, items: b.items.map(itemDto), txns: b.txns.map((t) => txnDto(t, baMap, uMap)), createdAt: b.createdAt.toISOString(),
  };
}

export async function listGirvi(ctx: TenantContext, query: any): Promise<Paged<GirviListItemDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.partyId ? { partyId: query.partyId } : {}),
    ...(query.from || query.to ? { issueDate: { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) } } : {}),
  };
  if (query.q || query.partyType) {
    const parties = await sdb.party.findMany({
      where: {
        ...(query.partyType ? { type: query.partyType } : {}),
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] } : {}),
      },
      select: { id: true },
    });
    const ids = { partyId: { in: parties.map((p) => p.id) } };
    const asNo = Number(query.q);
    // a numeric q may be a girvi number; partyType still narrows it
    where.AND = [query.q && Number.isInteger(asNo) && !query.partyType ? { OR: [{ girviNo: asNo }, ids] } : ids];
  }
  const [rows, total] = await Promise.all([
    sdb.girviBatch.findMany({ where, include: { items: { select: { name: true, status: true } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.girviBatch.count({ where }),
  ]);
  const parties = new Map((await sdb.party.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.partyId))] } } })).map((p) => [p.id, p]));
  const sums = await prisma.girviTxn.groupBy({
    by: ['batchId', 'type'],
    where: { batchId: { in: rows.map((b) => b.id) }, isReversed: false },
    _sum: { principal: true, interest: true, cash: true, online: true },
  });
  const sum = (batchId: number, types: string[], f: 'principal' | 'interest' | 'cash' | 'online') =>
    sums.filter((r) => r.batchId === batchId && types.includes(r.type)).reduce((a, r) => a.plus(r._sum[f] ?? 0), new Prisma.Decimal(0));
  const today = ledger.businessDate();
  const items: GirviListItemDto[] = rows.map((b) => ({
    id: b.id, girviNo: b.girviNo, party: partyRef(parties.get(b.partyId)), issueDate: dateOnly(b.issueDate), returnDate: dateOnly(b.returnDate),
    itemCount: b.items.length, pledgedCount: b.items.filter((i) => i.status === 'PLEDGED').length, valuation: money(b.valuation), principal: money(b.principal), interestDue: dueOf(b, today),
    overdue: b.status === 'ACTIVE' && today.getTime() > b.returnDate.getTime(), status: b.status,
    createdAt: b.createdAt.toISOString(),
    itemNames: b.items.map((i) => i.name),
    interestType: b.interestType,
    ratePercent: b.ratePercent.toString(),
    principalGiven: money(sum(b.id, ['GRANT', 'TOPUP'], 'principal')),
    principalReturned: money(sum(b.id, ['RELEASE'], 'principal')),
    interestPaid: money(sum(b.id, ['INTEREST', 'RELEASE'], 'interest')),
    payoutCash: money(sum(b.id, ['GRANT'], 'cash')),
    payoutOnline: money(sum(b.id, ['GRANT'], 'online')),
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

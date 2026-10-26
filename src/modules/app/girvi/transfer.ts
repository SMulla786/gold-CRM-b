/**
 * Phase 9b — girvi transfer: pledged customer items are re-pledged to a lender against money received
 * (MONEY IN, source GIRVI_TRANSFER); receiving them back repays principal + interest (MONEY OUT).
 * Interest owed to the lender uses the same shared calc as customer girvi.
 */
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import { girviInterest } from '../../../shared';
import type { girviTransferBody, girviTransferReturnBody, GirviTransferDto, Paged, PartyRefDto } from '../../../shared';

type TransferBody = z.infer<typeof girviTransferBody>;
type ReturnBody = z.infer<typeof girviTransferReturnBody>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const money = (d: unknown) => D(d).toFixed(2);
const wt = (d: unknown) => D(d).toFixed(3);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });
const addMonths = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
};
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for girvi (set X-Branch-Id)');
  return ctx.activeBranchId;
}
const assertBank = async (ctx: TenantContext, online: number, bankAccountId?: number) => {
  if (online > 0 && !(await scopedDb(ctx).bankAccount.findUnique({ where: { id: bankAccountId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
};

function moneyRows(branchId: number, txnDate: Date, direction: 'IN' | 'OUT', cash: number, online: number, bankAccountId: number | null, transferId: number, partyId: number, narration: string): ledger.LedgerEntryInput[] {
  const base = { branchId, txnDate, asset: 'MONEY' as const, direction, source: 'GIRVI_TRANSFER' as const, sourceId: String(transferId), partyId, narration };
  const rows: ledger.LedgerEntryInput[] = [];
  if (cash > 0) rows.push({ ...base, amount: cash });
  if (online > 0) rows.push({ ...base, bankAccountId, amount: online });
  return rows;
}

/** Interest owed to the lender from transferDate to `to`. */
const owed = (t: any, to: Date): string =>
  girviInterest({ principal: t.principal, ratePercent: t.ratePercent, ratePeriod: t.ratePeriod, interestType: t.interestType, ciPeriod: t.ciPeriod ?? undefined, method: t.method, from: dateOnly(t.transferDate), to: dateOnly(to) }).interest;

export async function createTransfer(ctx: TenantContext, body: TransferBody): Promise<GirviTransferDto> {
  const branchId = activeBranch(ctx);
  const lender = await scopedDb(ctx).party.findUnique({ where: { id: body.lenderPartyId } });
  if (!lender) throw new HttpError(404, 'NOT_FOUND', 'Lender not found');
  await assertBank(ctx, body.online, body.bankAccountId);
  const itemIds = [...new Set(body.itemIds)].sort((a, b) => a - b);
  const transferDate = ledger.businessDate(body.transferDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    // Lock the items (same order as releaseGirvi), then require each pledged on an ACTIVE batch of this branch and not already out.
    await tx.$queryRaw`SELECT id FROM "GirviItem" WHERE id = ANY(${itemIds}::int[]) ORDER BY id FOR UPDATE`;
    const items = await tx.girviItem.findMany({ where: { id: { in: itemIds } }, include: { batch: true } });
    const ok = items.filter((i) => i.status === 'PLEDGED' && i.batch.status === 'ACTIVE' && i.batch.businessId === ctx.businessId && i.batch.branchId === branchId);
    if (ok.length !== itemIds.length) throw new HttpError(409, 'CONFLICT', 'Every item must be pledged on an active girvi of this branch');
    if (await tx.girviTransferItem.count({ where: { girviItemId: { in: itemIds }, transfer: { status: 'ACTIVE' } } })) {
      throw new HttpError(409, 'CONFLICT', 'An item is already with a lender');
    }

    const seq = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, 'GIRVI_TRANSFER', 2)
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const transferNo = Number(seq[0]!.next) - 1;
    const t = await tx.girviTransfer.create({
      data: {
        businessId: ctx.businessId!, branchId, transferNo, lenderPartyId: lender.id, transferDate, tenureMonths: body.tenureMonths, returnDate: addMonths(transferDate, body.tenureMonths),
        ratePercent: body.ratePercent, ratePeriod: body.ratePeriod, interestType: body.interestType, ciPeriod: body.ciPeriod ?? null, method: body.method,
        principal: body.principal, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, remark: body.remark ?? null, createdById: ctx.userId,
        items: { create: itemIds.map((girviItemId) => ({ girviItemId })) },
      },
    });
    await ledger.post(tx, lctxOf(ctx), moneyRows(branchId, transferDate, 'IN', body.cash, body.online, body.bankAccountId ?? null, t.id, lender.id, `Girvi transfer #${transferNo} received`));
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'CREATED', entity: 'GIRVI_TRANSFER', entityId: String(t.id), summary: `Girvi transfer #${transferNo} ₹${body.principal} (${itemIds.length} items)`, partyName: lender.name });
    return t.id;
  });
  return getTransfer(ctx, id);
}

/** Receive the items back: pay the lender principal + interest, exactly once (guarded status flip). */
export async function returnTransfer(ctx: TenantContext, id: number, body: ReturnBody): Promise<GirviTransferDto> {
  const t = await scopedDb(ctx).girviTransfer.findFirst({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Transfer not found');
  if (t.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Transfer already received back');
  await assertBank(ctx, body.online, body.bankAccountId);
  const returnedOn = ledger.businessDate(body.returnedOn ?? new Date());
  if (returnedOn.getTime() < t.transferDate.getTime()) throw new HttpError(400, 'VALIDATION', 'Return date is before the transfer date');
  const total = D(t.principal).plus(body.interest);
  if (!total.minus(D(body.cash).plus(body.online)).abs().lt(0.005)) {
    throw new HttpError(400, 'VALIDATION', 'Cash + online must equal principal + interest', { total: total.toFixed(2) });
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.girviTransfer.updateMany({
      where: { id, status: 'ACTIVE' },
      data: {
        status: 'RETURNED', returnedOn, interestPaid: body.interest, returnCash: body.cash, returnOnline: body.online,
        returnBankAccountId: body.online > 0 ? body.bankAccountId! : null, ...(body.remark ? { remark: body.remark } : {}),
      },
    });
    if (count === 0) throw new HttpError(409, 'CONFLICT', 'Transfer already received back');
    await ledger.post(tx, lctxOf(ctx), moneyRows(t.branchId, returnedOn, 'OUT', body.cash, body.online, body.bankAccountId ?? null, id, t.lenderPartyId, `Girvi transfer #${t.transferNo} repaid`));
    await logActivity(tx, ctx, { module: 'GIRVI', action: 'EDITED', entity: 'GIRVI_TRANSFER', entityId: String(id), summary: `Girvi transfer #${t.transferNo} received back ₹${total.toFixed(2)}` });
  });
  return getTransfer(ctx, id);
}

async function toDtos(ctx: TenantContext, rows: any[]): Promise<GirviTransferDto[]> {
  const links = await prisma.girviTransferItem.findMany({ where: { transferId: { in: rows.map((r) => r.id) } }, include: { girviItem: { include: { batch: true } } } });
  const partyIds = [...new Set<number>([...rows.map((r) => r.lenderPartyId), ...links.map((l) => l.girviItem.batch.partyId)])];
  const parties = new Map((await scopedDb(ctx).party.findMany({ where: { id: { in: partyIds } } })).map((p) => [p.id, p]));
  const today = ledger.businessDate();
  return rows.map((t) => ({
    id: t.id, transferNo: t.transferNo, lender: partyRef(parties.get(t.lenderPartyId)), transferDate: dateOnly(t.transferDate), returnDate: dateOnly(t.returnDate),
    tenureMonths: t.tenureMonths, ratePercent: String(t.ratePercent), ratePeriod: t.ratePeriod, interestType: t.interestType, ciPeriod: t.ciPeriod, method: t.method,
    principal: money(t.principal), cash: money(t.cash), online: money(t.online), status: t.status,
    interest: t.status === 'ACTIVE' ? owed(t, today) : money(t.interestPaid),
    returnedOn: t.returnedOn ? dateOnly(t.returnedOn) : null,
    items: links
      .filter((l) => l.transferId === t.id)
      .map((l) => ({
        id: l.girviItem.id, batchId: l.girviItem.batchId, girviNo: l.girviItem.batch.girviNo, customer: partyRef(parties.get(l.girviItem.batch.partyId)),
        name: l.girviItem.name, category: l.girviItem.category, net: wt(l.girviItem.net), fine: wt(l.girviItem.fine), valuation: money(l.girviItem.valuation),
      })),
    remark: t.remark, createdAt: t.createdAt.toISOString(),
  }));
}

export async function getTransfer(ctx: TenantContext, id: number): Promise<GirviTransferDto> {
  const t = await scopedDb(ctx).girviTransfer.findFirst({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Transfer not found');
  return (await toDtos(ctx, [t]))[0]!;
}

export async function listTransfers(ctx: TenantContext, query: any): Promise<Paged<GirviTransferDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.lenderPartyId ? { lenderPartyId: query.lenderPartyId } : {}),
    ...(query.from || query.to ? { transferDate: { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.girviTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.girviTransfer.count({ where }),
  ]);
  return { items: await toDtos(ctx, rows), total, page: query.page, pageSize: query.pageSize };
}

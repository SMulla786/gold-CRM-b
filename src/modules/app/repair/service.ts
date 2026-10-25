import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import type { RepairTicketDto } from '../../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const money = (v: unknown) => D(v).toFixed(2);
const wt = (v: unknown) => D(v).toFixed(3);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch (set X-Branch-Id)');
  return ctx.activeBranchId;
}

async function nextNo(tx: Prisma.TransactionClient, businessId: number, branchId: number, key: string): Promise<number> {
  const r = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${businessId}, ${branchId}, ${key}, 2)
    ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
  return r[0]!.next - 1;
}

const FLOW = ['RECEIVED', 'IN_PROGRESS', 'IN_REVIEW', 'READY', 'DELIVERED'] as const;

type RepairBody = { partyId: number; metal: 'GOLD' | 'SILVER' | 'OTHER'; category: string; description: string; pcs: number; gross: number; net?: number; karatCode?: string; hallmark?: string; expectedDate: Date; priority: 'NORMAL' | 'URGENT' | 'EXPRESS'; karigarId?: number; labourCharge: number; otherCharge: number; advanceCash: number; advanceOnline: number; advanceBankId?: number };

export async function createRepair(ctx: TenantContext, body: RepairBody): Promise<RepairTicketDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  if (!(await sdb.party.findUnique({ where: { id: body.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  if (body.karigarId != null) {
    const k = await sdb.party.findUnique({ where: { id: body.karigarId } });
    if (!k) throw new HttpError(404, 'NOT_FOUND', 'Karigar not found');
    if (k.type !== 'KARIGAR') throw new HttpError(400, 'VALIDATION', 'That party is not a karigar');
  }
  if (body.advanceBankId != null && !(await sdb.bankAccount.findUnique({ where: { id: body.advanceBankId } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');

  const txnDate = ledger.businessDate();
  const lctx = lctxOf(ctx);
  const id = await prisma.$transaction(async (tx) => {
    const ticketNo = await nextNo(tx, ctx.businessId!, branchId, 'REPAIR');
    const t = await tx.repairTicket.create({ data: {
      businessId: ctx.businessId!, branchId, ticketNo, partyId: body.partyId, metal: body.metal, category: body.category, description: body.description,
      pcs: body.pcs, gross: body.gross, net: body.net ?? null, karatCode: body.karatCode ?? null, hallmark: body.hallmark ?? null,
      expectedDate: ledger.businessDate(body.expectedDate), priority: body.priority, status: 'RECEIVED', karigarId: body.karigarId ?? null,
      labourCharge: body.labourCharge, otherCharge: body.otherCharge, advanceCash: body.advanceCash, advanceOnline: body.advanceOnline, advanceBankId: body.advanceBankId ?? null, createdById: ctx.userId,
    } });
    const rows: ledger.LedgerEntryInput[] = [];
    if (body.advanceCash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', amount: body.advanceCash, source: 'REPAIR', sourceId: String(t.id), narration: 'Repair advance (cash)' });
    if (body.advanceOnline > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', bankAccountId: body.advanceBankId ?? null, amount: body.advanceOnline, source: 'REPAIR', sourceId: String(t.id), narration: 'Repair advance (online)' });
    if (rows.length) await ledger.post(tx, lctx, rows);
    await logActivity(tx, ctx, { module: 'REPAIR', action: 'CREATED', entity: 'RepairTicket', entityId: String(t.id), summary: `Repair ticket #${ticketNo}` });
    return t.id;
  });
  return getRepair(ctx, id);
}

export async function updateRepairStatus(ctx: TenantContext, id: number, body: { status: 'IN_PROGRESS' | 'IN_REVIEW' | 'READY' | 'CANCELLED'; karigarId?: number; finalWeight?: number; remarks?: string }): Promise<RepairTicketDto> {
  const sdb = scopedDb(ctx);
  const t = await sdb.repairTicket.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Repair ticket not found');
  if (t.status === 'DELIVERED' || t.status === 'CANCELLED') throw new HttpError(409, 'CONFLICT', `A ${t.status.toLowerCase()} ticket cannot change status`);
  if (body.status === 'CANCELLED') {
    await sdb.repairTicket.update({ where: { id }, data: { status: 'CANCELLED', ...(body.karigarId != null ? { karigarId: body.karigarId } : {}) } });
    return getRepair(ctx, id);
  }
  // forward only
  if (FLOW.indexOf(body.status) <= FLOW.indexOf(t.status as any)) throw new HttpError(409, 'CONFLICT', `Cannot move a ${t.status} ticket to ${body.status}`);
  if (body.status === 'READY' && (body.finalWeight == null || !body.remarks)) throw new HttpError(400, 'VALIDATION', 'Final weight and remarks are required to mark READY');
  await sdb.repairTicket.update({ where: { id }, data: { status: body.status, ...(body.karigarId != null ? { karigarId: body.karigarId } : {}), ...(body.finalWeight != null ? { finalWeight: body.finalWeight } : {}), ...(body.remarks ? { remarks: body.remarks } : {}) } });
  return getRepair(ctx, id);
}

type DeliverBody = { addedMetal?: 'GOLD' | 'SILVER'; addedFine: number; addedRate: number; cash: number; online: number; bankAccountId?: number; remarks?: string };

export async function deliverRepair(ctx: TenantContext, id: number, body: DeliverBody): Promise<RepairTicketDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const t = await sdb.repairTicket.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Repair ticket not found');
  if (t.status !== 'READY') throw new HttpError(409, 'CONFLICT', 'Only a READY ticket can be delivered');
  if (body.bankAccountId != null && !(await sdb.bankAccount.findUnique({ where: { id: body.bankAccountId } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');

  const addedValue = D(body.addedFine).times(body.addedRate); // addedRate is per gram
  const charges = D(t.labourCharge).plus(t.otherCharge).plus(addedValue);
  const advance = D(t.advanceCash).plus(t.advanceOnline);
  const paid = D(body.cash).plus(body.online);
  const balance = charges.minus(advance).minus(paid);
  const txnDate = ledger.businessDate();
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const rows: ledger.LedgerEntryInput[] = [];
    if (body.cash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', amount: body.cash, source: 'REPAIR', sourceId: String(id), narration: 'Repair delivery (cash)' });
    if (body.online > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', bankAccountId: body.bankAccountId ?? null, amount: body.online, source: 'REPAIR', sourceId: String(id), narration: 'Repair delivery (online)' });
    if (body.addedFine > 0 && body.addedMetal) rows.push({ branchId, txnDate, asset: body.addedMetal, direction: 'OUT', metalForm: 'USUAL', gross: body.addedFine, net: body.addedFine, fine: body.addedFine, amount: addedValue, source: 'REPAIR', sourceId: String(id), narration: 'Repair solder (shop metal)' });
    if (rows.length) await ledger.post(tx, lctx, rows);
    if (!balance.isZero()) await udhar.post(tx, lctx, [{ branchId, partyId: t.partyId, txnDate, amount: balance, source: 'REPAIR', sourceId: String(id), narration: `Repair #${t.ticketNo} balance` }]);
    await tx.repairTicket.update({ where: { id }, data: { status: 'DELIVERED', addedMetal: body.addedMetal ?? null, addedFine: body.addedFine || null, addedRate: body.addedRate || null, deliveryCash: body.cash, deliveryOnline: body.online, deliveryBankId: body.bankAccountId ?? null, deliveredAt: new Date(), ...(body.remarks ? { remarks: body.remarks } : {}) } });
    await logActivity(tx, ctx, { module: 'REPAIR', action: 'EDITED', entity: 'RepairTicket', entityId: String(id), summary: `Repair ticket #${t.ticketNo} delivered` });
  });
  return getRepair(ctx, id);
}

export async function listRepairs(ctx: TenantContext, q: { page: number; pageSize: number; status?: string; partyId?: number }): Promise<{ items: RepairTicketDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  const where = { ...(q.status ? { status: q.status as any } : {}), ...(q.partyId ? { partyId: q.partyId } : {}) };
  const [rows, total] = await Promise.all([
    sdb.repairTicket.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    sdb.repairTicket.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => getRepair(ctx, r.id))), total, page: q.page, pageSize: q.pageSize };
}

export async function getRepair(ctx: TenantContext, id: number): Promise<RepairTicketDto> {
  const sdb = scopedDb(ctx);
  const t = await sdb.repairTicket.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Repair ticket not found');
  const [party, karigar] = await Promise.all([
    sdb.party.findUnique({ where: { id: t.partyId }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }),
    t.karigarId != null ? sdb.party.findUnique({ where: { id: t.karigarId }, select: { id: true, name: true } }) : null,
  ]);
  const advance = D(t.advanceCash).plus(t.advanceOnline);
  const addedValue = D(t.addedFine ?? 0).times(t.addedRate ?? 0);
  const deliveryPaid = D(t.deliveryCash ?? 0).plus(t.deliveryOnline ?? 0);
  const balance = D(t.labourCharge).plus(t.otherCharge).plus(addedValue).minus(advance).minus(deliveryPaid);
  return {
    id: t.id, ticketNo: t.ticketNo, party: party as any, metal: t.metal as any, category: t.category, description: t.description, pcs: t.pcs,
    gross: wt(t.gross), net: t.net != null ? wt(t.net) : null, karatCode: t.karatCode, hallmark: t.hallmark, photoUrl: t.photoUrl,
    expectedDate: t.expectedDate.toISOString().slice(0, 10), priority: t.priority as any, status: t.status as any,
    karigar: karigar ? { id: karigar.id, name: karigar.name } : null, labourCharge: money(t.labourCharge), otherCharge: money(t.otherCharge),
    advance: money(advance), finalWeight: t.finalWeight != null ? wt(t.finalWeight) : null, remarks: t.remarks, balance: money(balance),
    deliveredAt: t.deliveredAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
  };
}

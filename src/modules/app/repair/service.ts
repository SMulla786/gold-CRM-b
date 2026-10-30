import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import type { RepairConsumableDto, RepairTicketDto } from '../../../shared';
import { filePath, replaceFile } from '../orders/files';

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

type RepairBody = { partyId: number; metal: 'GOLD' | 'SILVER' | 'OTHER'; category: string; description: string; pcs: number; gross: number; net?: number; karatCode?: string; hallmark?: string; expectedDate: Date; priority: 'NORMAL' | 'URGENT' | 'EXPRESS'; karigarId?: number; labourCharge: number; otherCharge: number; advanceCash: number; advanceOnline: number; advanceBankId?: number; purity?: number; subCategory?: string; initialStatus?: 'RECEIVED' | 'IN_PROGRESS' };

export async function createRepair(ctx: TenantContext, body: RepairBody): Promise<RepairTicketDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  if (!(await sdb.party.findUnique({ where: { id: body.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const initialStatus = body.initialStatus ?? 'RECEIVED';
  if (initialStatus === 'IN_PROGRESS' && body.karigarId == null) throw new HttpError(400, 'VALIDATION', 'Assign a karigar to start work on intake');
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
      expectedDate: ledger.businessDate(body.expectedDate), priority: body.priority, status: initialStatus, karigarId: body.karigarId ?? null,
      labourCharge: body.labourCharge, otherCharge: body.otherCharge, advanceCash: body.advanceCash, advanceOnline: body.advanceOnline, advanceBankId: body.advanceBankId ?? null, createdById: ctx.userId,
      purity: body.purity ?? null, subCategory: body.subCategory || null,
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
  if (body.karigarId != null) {
    // same tenant + KARIGAR check as createRepair (a foreign/non-karigar id must never be persisted)
    const k = await sdb.party.findUnique({ where: { id: body.karigarId } });
    if (!k) throw new HttpError(404, 'NOT_FOUND', 'Karigar not found');
    if (k.type !== 'KARIGAR') throw new HttpError(400, 'VALIDATION', 'That party is not a karigar');
  }
  if (body.status === t.status) {
    // same status = karigar (re)assignment only; status itself never moves backward or sideways
    if (body.karigarId == null) throw new HttpError(409, 'CONFLICT', `Ticket is already ${t.status}`);
    const c = await sdb.repairTicket.updateMany({ where: { id, status: t.status }, data: { karigarId: body.karigarId } });
    if (c.count !== 1) throw new HttpError(409, 'CONFLICT', 'Ticket status just changed');
    return getRepair(ctx, id);
  }
  if (body.status === 'CANCELLED') {
    // Charges are dropped; any advance taken stays with the shop as the customer's credit (udhar −advance). No refund here —
    // paying it back is its own transaction.
    const advance = D(t.advanceCash).plus(t.advanceOnline);
    await prisma.$transaction(async (tx) => {
      // guard on the current status so a concurrent move (or a second cancel) can't flip it out from under us
      const c = await tx.repairTicket.updateMany({ where: { id, status: t.status }, data: { status: 'CANCELLED', ...(body.karigarId != null ? { karigarId: body.karigarId } : {}) } });
      if (c.count !== 1) throw new HttpError(409, 'CONFLICT', 'Ticket status just changed');
      if (advance.gt(0)) await udhar.post(tx, lctxOf(ctx), [{ branchId: t.branchId, partyId: t.partyId, txnDate: ledger.businessDate(), amount: advance.negated(), source: 'REPAIR', sourceId: String(id), narration: `Repair #${t.ticketNo} cancelled — advance kept as credit` }]);
      await logActivity(tx, ctx, { module: 'REPAIR', action: 'EDITED', entity: 'RepairTicket', entityId: String(id), summary: `Repair ticket #${t.ticketNo} cancelled${advance.gt(0) ? ` — ₹${money(advance)} advance kept as credit` : ''}` });
    });
    return getRepair(ctx, id);
  }
  // forward only
  if (FLOW.indexOf(body.status) <= FLOW.indexOf(t.status as any)) throw new HttpError(409, 'CONFLICT', `Cannot move a ${t.status} ticket to ${body.status}`);
  if (body.status === 'READY' && (body.finalWeight == null || !body.remarks)) throw new HttpError(400, 'VALIDATION', 'Final weight and remarks are required to mark READY');
  const c = await sdb.repairTicket.updateMany({ where: { id, status: t.status }, data: { status: body.status, ...(body.karigarId != null ? { karigarId: body.karigarId } : {}), ...(body.finalWeight != null ? { finalWeight: body.finalWeight } : {}), ...(body.remarks ? { remarks: body.remarks } : {}) } });
  if (c.count !== 1) throw new HttpError(409, 'CONFLICT', 'Ticket status just changed');
  return getRepair(ctx, id);
}

/** QA "return to bench": IN_REVIEW → IN_PROGRESS only — the one backward move; the generic status route stays forward-only. */
export async function rejectRepair(ctx: TenantContext, id: number, body: { remarks: string }): Promise<RepairTicketDto> {
  const t = await scopedDb(ctx).repairTicket.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Repair ticket not found');
  if (t.status !== 'IN_REVIEW') throw new HttpError(409, 'CONFLICT', `Only a ticket in QA review can be returned to the bench (this one is ${t.status})`);
  const note = `QA returned: ${body.remarks}`;
  await prisma.$transaction(async (tx) => {
    // id was tenant-checked above; guard on IN_REVIEW so a concurrent move can't be overwritten
    const c = await tx.repairTicket.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'IN_PROGRESS', remarks: t.remarks ? `${t.remarks}; ${note}` : note } });
    if (c.count !== 1) throw new HttpError(409, 'CONFLICT', 'Ticket status just changed');
    await logActivity(tx, ctx, { module: 'REPAIR', action: 'EDITED', entity: 'RepairTicket', entityId: String(id), summary: `Repair ticket #${t.ticketNo} returned to bench: ${body.remarks}` });
  });
  return getRepair(ctx, id);
}

type DeliverBody = { addedMetal?: 'GOLD' | 'SILVER' | 'OTHER'; addedKaratCode?: string; addedFine: number; addedRate: number; cash: number; online: number; bankAccountId?: number; remarks?: string };

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
    // claim the ticket atomically on its READY status BEFORE posting — a ticket can't be delivered twice (BUG-10)
    const claim = await tx.repairTicket.updateMany({ where: { id, status: 'READY' }, data: { status: 'DELIVERED', addedMetal: body.addedMetal === 'OTHER' ? null : (body.addedMetal ?? null), addedKaratCode: body.addedMetal === 'OTHER' ? 'OTHER' : (body.addedKaratCode || null), addedFine: body.addedFine || null, addedRate: body.addedRate || null, deliveryCash: body.cash, deliveryOnline: body.online, deliveryBankId: body.bankAccountId ?? null, deliveredAt: new Date(), ...(body.remarks ? { remarks: body.remarks } : {}) } });
    if (claim.count !== 1) throw new HttpError(409, 'CONFLICT', 'Ticket was just delivered');
    const rows: ledger.LedgerEntryInput[] = [];
    if (body.cash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', amount: body.cash, source: 'REPAIR', sourceId: String(id), narration: 'Repair delivery (cash)' });
    if (body.online > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', bankAccountId: body.bankAccountId ?? null, amount: body.online, source: 'REPAIR', sourceId: String(id), narration: 'Repair delivery (online)' });
    // OTHER metal: value is billed (addedValue above) but nothing leaves shop stock
    if (body.addedFine > 0 && (body.addedMetal === 'GOLD' || body.addedMetal === 'SILVER')) rows.push({ branchId, txnDate, asset: body.addedMetal, direction: 'OUT', metalForm: 'USUAL', karatCode: body.addedKaratCode || null, gross: body.addedFine, net: body.addedFine, fine: body.addedFine, amount: addedValue, source: 'REPAIR', sourceId: String(id), narration: 'Repair solder (shop metal)' });
    if (rows.length) await ledger.post(tx, lctx, rows);
    if (!balance.isZero()) await udhar.post(tx, lctx, [{ branchId, partyId: t.partyId, txnDate, amount: balance, source: 'REPAIR', sourceId: String(id), narration: `Repair #${t.ticketNo} balance` }]);
    await logActivity(tx, ctx, { module: 'REPAIR', action: 'EDITED', entity: 'RepairTicket', entityId: String(id), summary: `Repair ticket #${t.ticketNo} delivered` });
  });
  return getRepair(ctx, id);
}

export async function listRepairs(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; status?: string; partyId?: number; metal?: string; from?: Date; to?: Date }): Promise<{ items: RepairTicketDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  // q: ticket no (with or without '#'), party name / mobile, description or category
  const kw = q.q?.trim();
  let kwWhere: Prisma.RepairTicketWhereInput = {};
  if (kw) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: kw, mode: 'insensitive' } }, { mobile: { contains: kw } }] }, select: { id: true } });
    // ticketNo is Int4: only digits that fit (a 10-digit mobile must not reach it, it would overflow → 500)
    const num = /^#?\d+$/.test(kw) ? Number(kw.replace('#', '')) : NaN;
    const ticketNo = Number.isInteger(num) && num > 0 && num <= 2_147_483_647 ? num : null;
    kwWhere = { OR: [
      ...(ticketNo != null ? [{ ticketNo }] : []),
      { partyId: { in: parties.map((p) => p.id) } },
      { description: { contains: kw, mode: 'insensitive' } },
      { category: { contains: kw, mode: 'insensitive' } },
    ] };
  }
  // from/to are business dates (inclusive) on the createdAt timestamp: IST midnight in UTC
  const istStart = (d: Date) => new Date(ledger.businessDate(d).getTime() - 330 * 60_000);
  const created = q.from || q.to ? { createdAt: { ...(q.from ? { gte: istStart(q.from) } : {}), ...(q.to ? { lt: new Date(istStart(q.to).getTime() + 86_400_000) } : {}) } } : {};
  const where: Prisma.RepairTicketWhereInput = { ...(q.status ? { status: q.status as any } : {}), ...(q.partyId ? { partyId: q.partyId } : {}), ...(q.metal ? { metal: q.metal } : {}), ...created, ...kwWhere };
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
  const [party, karigar, bank] = await Promise.all([
    sdb.party.findUnique({ where: { id: t.partyId }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }),
    t.karigarId != null ? sdb.party.findUnique({ where: { id: t.karigarId }, select: { id: true, name: true } }) : null,
    t.deliveryBankId != null ? sdb.bankAccount.findUnique({ where: { id: t.deliveryBankId }, select: { id: true, bankName: true } }) : null,
  ]);
  const advance = D(t.advanceCash).plus(t.advanceOnline);
  const addedValue = D(t.addedFine ?? 0).times(t.addedRate ?? 0);
  const deliveryPaid = D(t.deliveryCash ?? 0).plus(t.deliveryOnline ?? 0);
  // CANCELLED: no charges are owed; the advance is the customer's credit (matches the udhar −advance posted on cancel)
  const balance = t.status === 'CANCELLED' ? advance.negated() : D(t.labourCharge).plus(t.otherCharge).plus(addedValue).minus(advance).minus(deliveryPaid);
  return {
    id: t.id, ticketNo: t.ticketNo, party: party as any, metal: t.metal as any, category: t.category, description: t.description, pcs: t.pcs,
    gross: wt(t.gross), net: t.net != null ? wt(t.net) : null, karatCode: t.karatCode, hallmark: t.hallmark, photoUrl: t.photoUrl,
    expectedDate: t.expectedDate.toISOString().slice(0, 10), priority: t.priority as any, status: t.status as any,
    karigar: karigar ? { id: karigar.id, name: karigar.name } : null, labourCharge: money(t.labourCharge), otherCharge: money(t.otherCharge),
    advance: money(advance), finalWeight: t.finalWeight != null ? wt(t.finalWeight) : null, remarks: t.remarks, balance: money(balance),
    deliveredAt: t.deliveredAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
    purity: t.purity != null ? D(t.purity).toFixed(2) : null, subCategory: t.subCategory,
    // OTHER is stored as addedMetal null + addedKaratCode 'OTHER' (MetalKind has no OTHER)
    addedMetal: t.addedMetal ?? (t.addedKaratCode === 'OTHER' ? 'OTHER' : null), addedFine: t.addedFine != null ? wt(t.addedFine) : null,
    addedRate: t.addedRate != null ? money(t.addedRate) : null, addedKaratCode: t.addedKaratCode === 'OTHER' ? null : t.addedKaratCode,
    deliveryCash: t.deliveryCash != null ? money(t.deliveryCash) : null, deliveryOnline: t.deliveryOnline != null ? money(t.deliveryOnline) : null,
    deliveryBank: bank ? { id: bank.id, name: bank.bankName } : null,
  };
}

// ───────────── Photo (TASK-97) ─────────────

export async function saveRepairPhoto(ctx: TenantContext, id: number, buffer: Buffer): Promise<void> {
  const t = await scopedDb(ctx).repairTicket.findUnique({ where: { id }, select: { photoUrl: true } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Repair ticket not found');
  await replaceFile(ctx, 'repair', buffer, t.photoUrl, (rel) => scopedDb(ctx).repairTicket.update({ where: { id }, data: { photoUrl: rel } }));
}

export async function repairPhotoPath(ctx: TenantContext, id: number): Promise<string> {
  return filePath((await scopedDb(ctx).repairTicket.findUnique({ where: { id }, select: { photoUrl: true } }))?.photoUrl);
}

// ───────────── Consumables (TASK-97) ─────────────
// RepairConsumable is not in lib/db TENANT_MODELS, so every query pins businessId + branch explicitly.

const consumableScope = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchId: { in: ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds } });

function consumableDto(c: any): RepairConsumableDto {
  const stock = D(c.currentStock);
  return {
    id: c.id, name: c.name, category: c.category, unit: c.unit, currentStock: wt(c.currentStock), minLevel: wt(c.minLevel), isActive: c.isActive,
    status: stock.lte(0) ? 'OUT' : stock.lte(c.minLevel) ? 'LOW' : 'OK', updatedAt: c.updatedAt.toISOString(),
  };
}

async function findConsumable(ctx: TenantContext, id: number) {
  const c = await prisma.repairConsumable.findFirst({ where: { id, ...consumableScope(ctx) } });
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'Consumable not found');
  return c;
}

export async function listConsumables(ctx: TenantContext): Promise<RepairConsumableDto[]> {
  const rows = await prisma.repairConsumable.findMany({ where: consumableScope(ctx), orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  return rows.map(consumableDto);
}

type ConsumableBody = { name: string; category?: string; unit: string; currentStock: number; minLevel: number; isActive: boolean };

export async function createConsumable(ctx: TenantContext, body: ConsumableBody): Promise<RepairConsumableDto> {
  const branchId = activeBranch(ctx);
  const c = await prisma.repairConsumable.create({ data: { businessId: ctx.businessId!, branchId, name: body.name, category: body.category || null, unit: body.unit, currentStock: body.currentStock, minLevel: body.minLevel, isActive: body.isActive } });
  return consumableDto(c);
}

export async function updateConsumable(ctx: TenantContext, id: number, body: Partial<Omit<ConsumableBody, 'category'>> & { category?: string | null }): Promise<RepairConsumableDto> {
  await findConsumable(ctx, id);
  const c = await prisma.repairConsumable.update({ where: { id }, data: { ...body, ...(body.category !== undefined ? { category: body.category || null } : {}) } });
  return consumableDto(c);
}

export async function adjustConsumable(ctx: TenantContext, id: number, body: { delta: number; reason?: string }): Promise<RepairConsumableDto> {
  const c = await findConsumable(ctx, id);
  // atomic: stock never goes below zero, even with two quick taps
  const r = await prisma.repairConsumable.updateMany({ where: { id, ...(body.delta < 0 ? { currentStock: { gte: -body.delta } } : {}) }, data: { currentStock: { increment: body.delta } } });
  if (r.count !== 1) throw new HttpError(409, 'CONFLICT', 'Not enough stock to take out');
  await prisma.$transaction((tx) => logActivity(tx, ctx, { module: 'REPAIR', action: 'EDITED', entity: 'RepairConsumable', entityId: String(id), summary: `${c.name} stock ${body.delta > 0 ? '+' : ''}${body.delta}${body.reason ? ` (${body.reason})` : ''}` }));
  return consumableDto(await findConsumable(ctx, id));
}

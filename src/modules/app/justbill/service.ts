import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import { computeBill, computeJustLine } from '../../../shared';
import type { BillPaymentDto, JustBillBody, JustBillDto, JustBillLineDto, JustBillListItemDto, Paged, PartyRefDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { getSettings } from '../service';
import { computePayments, sumAmounts, type PayCalc } from '../billing/service';
import { fyStartYear, formatBillNo } from '../billing/numbering';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** A Just Bill belongs to one branch — admins must pick one via X-Branch-Id. */
function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for the bill (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Just Bill numbering: invoice.sale delimiter/padding/fyFormat but always prefix JB + FY, counter key JUST:<fy>. */
function jbNumbering(s: Awaited<ReturnType<typeof getSettings>>) {
  return { ...s['invoice.sale'], format: 'FY_PREFIX' as const, gstPrefix: 'JB' };
}

/** One ledger row per Just Bill payment (money / metal), always IN, source JUST_BILL. */
function justPaymentLedgerRow(pc: PayCalc, paymentId: number, justBillId: number, branchId: number, txnDate: Date): ledger.LedgerEntryInput {
  const base = { branchId, txnDate, direction: 'IN' as const, source: 'JUST_BILL' as const, sourceId: `${justBillId}-P${paymentId}` };
  if (pc.input.mode === 'METAL') return { ...base, asset: pc.metal!, metalForm: pc.metalForm, gross: pc.gross, net: pc.net, fine: pc.fine, amount: pc.amount, narration: 'Just bill metal payment' };
  return { ...base, asset: 'MONEY', bankAccountId: pc.bankAccountId ?? null, amount: pc.amount, narration: 'Just bill payment' };
}

/**
 * TASK-98 Udhar advance on a Just Bill — mirrors billing/service postNoCashPays (UDHAR_ADVANCE half). No ledger row (nothing enters the shop);
 * the bill takes `amount` of the party's udhar credit as a +amount udhar row under sourceId `<justBillId>-A` (reversed by deleteJustBill).
 * Credit = −Σ party udhar amount excluding this just bill's own balance row (source JUST_BILL, sourceId `<id>`); over-balance → 409 OVER_BALANCE.
 */
async function postAdvancePays(tx: Prisma.TransactionClient, ctx: TenantContext, jb: { id: number; billNo: string; branchId: number; partyId: number }, payCalcs: PayCalc[], txnDate: Date, lctx: ledger.LedgerContext): Promise<void> {
  const adv = payCalcs.filter((pc) => pc.input.mode === 'UDHAR_ADVANCE');
  if (!adv.length) return;
  await ledger.assertDaysOpen(tx, lctx, [{ branchId: jb.branchId, txnDate }]);
  const advance = adv.reduce((a, pc) => a.plus(D(pc.amount)), new Prisma.Decimal(0));
  await tx.$queryRaw`SELECT id FROM "Party" WHERE id = ${jb.partyId} FOR UPDATE`; // serialize concurrent uses of the same credit
  const sum = await tx.udharEntry.aggregate({ where: { businessId: ctx.businessId!, partyId: jb.partyId, NOT: { source: 'JUST_BILL', sourceId: String(jb.id) } }, _sum: { amount: true } });
  const credit = Prisma.Decimal.max(D(sum._sum.amount).negated(), 0);
  if (advance.gt(credit)) throw new HttpError(409, 'CONFLICT', `Udhar advance available is ₹${credit.toFixed(2)}`, { code: 'OVER_BALANCE' });
  for (const pc of adv) {
    await udhar.post(tx, lctx, [{ branchId: jb.branchId, partyId: jb.partyId, txnDate, amount: D(pc.amount), source: 'JUST_BILL', sourceId: `${jb.id}-A`, narration: `${jb.billNo} udhar advance` }]);
  }
}

export async function nextJustBillNo(ctx: TenantContext): Promise<{ billNo: string }> {
  const branchId = activeBranch(ctx);
  const s = await getSettings(ctx);
  const date = ledger.businessDate();
  const row = await prisma.docSequence.findUnique({ where: { businessId_branchId_key: { businessId: ctx.businessId!, branchId, key: `JUST:${fyStartYear(date)}` } } });
  return { billNo: formatBillNo(row ? row.next : 1, 'GST', jbNumbering(s), date) };
}

export async function createJustBill(ctx: TenantContext, body: JustBillBody): Promise<JustBillDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const s = await getSettings(ctx);

  const party = body.partyId != null ? await sdb.party.findUnique({ where: { id: body.partyId } }) : null;
  if (body.partyId != null && !party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');

  let interState = false;
  if (party?.stateId != null) {
    const branch = await sdb.branch.findUnique({ where: { id: branchId }, select: { stateId: true } });
    const business = await prisma.business.findUnique({ where: { id: ctx.businessId! }, select: { stateId: true } });
    const branchState = branch?.stateId ?? business?.stateId ?? null;
    interState = branchState != null && party.stateId !== branchState;
  }

  const lineCalcs = body.items.map((it) => {
    try {
      return computeJustLine({ quantity: it.quantity, unit: it.unit, rate: it.rate, making: it.making, makingUnit: it.makingUnit, other: it.other });
    } catch {
      throw new HttpError(400, 'VALIDATION', `Making per gram needs a GRAM line (item "${it.name}")`);
    }
  });
  if (body.partyId == null && body.payments.some((p) => p.mode === 'UDHAR_ADVANCE')) throw new HttpError(400, 'VALIDATION', 'Link a party to use udhar advance');
  const payCalcs = await computePayments(ctx, body.payments, s);
  const paid = sumAmounts(payCalcs);
  const billCalc = computeBill({ lineTotals: lineCalcs.map((l) => l.total), discount: body.discount, discountUnit: body.discountUnit, gstPercent: body.gstPercent, interState, roundTo: 1 });
  const bal = D(billCalc.final).minus(paid);
  if (body.partyId == null && !bal.isZero()) throw new HttpError(400, 'VALIDATION', 'Link a party to keep a balance');

  const billDate = ledger.businessDate(body.billDate ?? new Date());
  const customerName = party ? party.name : body.customerName!;
  const mobile = party ? party.mobile : (body.mobile ?? null);
  const lctx = lctxOf(ctx);

  const id = await prisma.$transaction(async (tx) => {
    const key = `JUST:${fyStartYear(billDate)}`;
    const seqRow = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, ${key}, 2)
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const seq = Number(seqRow[0]!.next) - 1;
    const billNo = formatBillNo(seq, 'GST', jbNumbering(s), billDate);
    const jb = await tx.justBill.create({
      data: {
        businessId: ctx.businessId!, branchId, billNo, seq, partyId: body.partyId ?? null, customerName, mobile, billDate, interState,
        sub: billCalc.sub, discount: body.discount, discountUnit: body.discountUnit, discountAmount: billCalc.discountAmount,
        gstPercent: body.gstPercent, taxable: billCalc.taxable, cgst: billCalc.cgst, sgst: billCalc.sgst, igst: billCalc.igst,
        total: billCalc.total, round: billCalc.round, final: billCalc.final, paid, remark: body.remark ?? null, status: 'ACTIVE', createdById: ctx.userId,
      },
    });
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i]!;
      await tx.justBillItem.create({ data: { justBillId: jb.id, name: it.name, karat: it.karat ?? null, purity: it.purity ?? null, quantity: it.quantity, unit: it.unit, rate: it.rate, making: it.making, makingUnit: it.makingUnit, other: it.other, total: lineCalcs[i]!.total } });
    }
    if (body.partyId != null) await postAdvancePays(tx, ctx, { id: jb.id, billNo, branchId, partyId: body.partyId }, payCalcs, billDate, lctx);
    for (const pc of payCalcs) {
      const pay = await tx.justBillPayment.create({ data: { justBillId: jb.id, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, txnDate: billDate, isActive: true, createdById: ctx.userId } });
      if (pc.input.mode !== 'UDHAR_ADVANCE') await ledger.post(tx, lctx, [justPaymentLedgerRow(pc, pay.id, jb.id, branchId, billDate)]);
    }
    if (body.partyId != null && !bal.isZero()) {
      await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate: billDate, source: 'JUST_BILL', sourceId: String(jb.id), amount: bal, narration: billNo }]); // + = party owes (same sign as SELL)
    }
    await logActivity(tx, ctx, { module: 'JUST_BILL', action: 'CREATED', entity: 'JUST_BILL', entityId: String(jb.id), summary: `Just bill ${billNo} ₹${billCalc.final}`, partyName: customerName });
    return jb.id;
  });
  return getJustBill(ctx, id);
}

export async function deleteJustBill(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const jb = await sdb.justBill.findFirst({ where: { id }, include: { payments: true } });
  if (!jb) throw new HttpError(404, 'NOT_FOUND', 'Just bill not found');
  if (jb.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Just bill is not active');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    const flipped = await tx.justBill.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'DELETED', deletedAt: new Date() } });
    if (flipped.count !== 1) throw new HttpError(409, 'CONFLICT', 'Just bill is not active');
    await tx.justBillPayment.updateMany({ where: { justBillId: id }, data: { isActive: false } });
    for (const p of jb.payments) await ledger.reverse(tx, lctx, { source: 'JUST_BILL', sourceId: `${id}-P${p.id}` });
    await udhar.reverse(tx, lctx, { source: 'JUST_BILL', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'JUST_BILL', sourceId: `${id}-A` }); // TASK-98 udhar advance uses
    await logActivity(tx, ctx, { module: 'JUST_BILL', action: 'DELETED', entity: 'JUST_BILL', entityId: String(id), summary: `Deleted just bill ${jb.billNo}` });
  });
}

// ───────────── DTO mappers + list/get ─────────────

const lineDto = (i: any): JustBillLineDto => ({ id: i.id, name: i.name, karat: i.karat, purity: i.purity != null ? String(i.purity) : null, quantity: String(i.quantity), unit: i.unit, rate: String(i.rate), making: String(i.making), makingUnit: i.makingUnit, other: String(i.other), total: String(i.total) });
const paymentDto = (p: any, baMap: Map<number, string>): BillPaymentDto => ({ id: p.id, mode: p.mode, bankAccount: p.bankAccountId != null ? { id: p.bankAccountId, name: baMap.get(p.bankAccountId) ?? '' } : null, metal: p.metal, metalForm: p.metalForm, gross: p.gross != null ? String(p.gross) : null, net: p.net != null ? String(p.net) : null, tunch: p.tunch != null ? String(p.tunch) : null, fine: p.fine != null ? String(p.fine) : null, rate: p.rate != null ? String(p.rate) : null, amount: String(p.amount), remark: p.remark, txnDate: dateOnly(p.txnDate), isActive: p.isActive, createdAt: p.createdAt.toISOString() });
const partyRef = (p: any): PartyRefDto | null => (p ? { id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName } : null);
const gramWeight = (items: any[]) => items.filter((i) => i.unit === 'GRAM').reduce((a, i) => a.plus(D(i.quantity)), new Prisma.Decimal(0)).toFixed(3);

const listFields = (b: any, party: PartyRefDto | null, createdBy: string | null): JustBillListItemDto => ({
  id: b.id, billNo: b.billNo, billDate: dateOnly(b.billDate), party, customerName: b.customerName, mobile: b.mobile,
  itemCount: b._count?.items ?? b.items?.length ?? 0, weight: gramWeight(b.items ?? []), sub: String(b.sub), discountAmount: String(b.discountAmount),
  gst: D(b.cgst).plus(b.sgst).plus(b.igst).toFixed(2), final: String(b.final), paid: String(b.paid), balance: D(b.final).minus(b.paid).toFixed(2),
  status: b.status, createdBy, createdAt: b.createdAt.toISOString(),
});

async function userNames(ctx: TenantContext, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => x != null))];
  if (!uniq.length) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: uniq }, businessId: ctx.businessId! }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

export async function getJustBill(ctx: TenantContext, id: number): Promise<JustBillDto> {
  const sdb = scopedDb(ctx);
  const jb = await sdb.justBill.findFirst({ where: { id }, include: { items: { orderBy: { id: 'asc' } }, payments: { orderBy: { id: 'asc' } } } });
  if (!jb) throw new HttpError(404, 'NOT_FOUND', 'Just bill not found');
  const party = jb.partyId != null ? await sdb.party.findUnique({ where: { id: jb.partyId } }) : null;
  const createdBy = (await userNames(ctx, [jb.createdById])).get(jb.createdById!) ?? null;
  const baIds = [...new Set(jb.payments.map((p) => p.bankAccountId).filter((x): x is number => x != null))];
  const baMap = new Map((baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : []).map((b) => [b.id, b.bankName]));
  return {
    ...listFields(jb, partyRef(party), createdBy),
    interState: jb.interState, discount: String(jb.discount), discountUnit: jb.discountUnit, gstPercent: String(jb.gstPercent), taxable: String(jb.taxable),
    cgst: String(jb.cgst), sgst: String(jb.sgst), igst: String(jb.igst), total: String(jb.total), round: String(jb.round), remark: jb.remark,
    items: jb.items.map(lineDto), payments: jb.payments.map((p) => paymentDto(p, baMap)),
  };
}

export async function listJustBills(ctx: TenantContext, query: any): Promise<Paged<JustBillListItemDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { status: query.status, ...(query.partyId ? { partyId: query.partyId } : {}) };
  if (query.from || query.to) where.billDate = { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) };
  if (query.q) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    where.OR = [{ billNo: { contains: query.q, mode: 'insensitive' } }, { customerName: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }, { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.justBill.findMany({ where, include: { items: { select: { unit: true, quantity: true } }, _count: { select: { items: true } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.justBill.count({ where }),
  ]);
  const parties = new Map((await sdb.party.findMany({ where: { id: { in: rows.map((b) => b.partyId).filter((x): x is number => x != null) } } })).map((p) => [p.id, p]));
  const users = await userNames(ctx, rows.map((b) => b.createdById));
  return {
    items: rows.map((b) => listFields(b, b.partyId != null ? partyRef(parties.get(b.partyId)) : null, b.createdById != null ? (users.get(b.createdById) ?? null) : null)),
    total, page: query.page, pageSize: query.pageSize,
  };
}

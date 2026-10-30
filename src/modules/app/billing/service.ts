import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import { computeBill, computeLine, fineWeight, metalToMoney, moneyToMetal, netWeight, PAN_CASH_LIMIT, RATE_UNIT_GRAMS, stoneTotal } from '../../../shared';
import type { BillBody, BillDto, BillKind, BillLineDto, BillListItemDto, BillPayInput, BillPaymentDto, BillType, LedgerSource, Paged, PartyRefDto, StockClass } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { getSettings } from '../service';
import { nextTagNo, stoneDto } from '../inventory';
import { docKey, formatBillNo, seriesStart } from './numbering';
import { redeemInTx, redeemRateFor, reopenForBill } from '../schemes/service';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Settings = Awaited<ReturnType<typeof getSettings>>;
const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });
const billSource = (kind: BillKind): LedgerSource => (kind === 'SELL' ? 'SELL_BILL' : 'PURCHASE_BILL');

/** A bill belongs to exactly one branch — admins must pick one via X-Branch-Id (not "all"). */
function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for the bill (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Rate unit (grams) for a line: SELL metals use the shop's rate unit; everything else is per gram. */
const rateUnitGrams = (cls: StockClass, kind: BillKind, s: Settings): number =>
  kind === 'PURCHASE' ? 1 : cls === 'GOLD' ? RATE_UNIT_GRAMS[s['rates.units'].gold] : cls === 'SILVER' ? RATE_UNIT_GRAMS[s['rates.units'].silver] : 1;
const metalUnitGrams = (metal: 'GOLD' | 'SILVER', s: Settings): number => RATE_UNIT_GRAMS[metal === 'GOLD' ? s['rates.units'].gold : s['rates.units'].silver];

// ───────────── Payments (shared by create + add-payments) ─────────────

export interface PayCalc {
  input: BillPayInput;
  amount: string;
  bankAccountId?: number;
  metal?: 'GOLD' | 'SILVER';
  metalForm?: 'BULLION' | 'KACHA';
  gross?: number;
  net?: string;
  fine?: string;
  tunch?: number;
  rate?: number;
  /** SCHEME: the scoped enrollment + its scheme + redeem rate, loaded by checkNoCashPays */
  enrollment?: any;
  scheme?: any;
  redeemRate?: number;
}

export async function computePayments(ctx: TenantContext, payments: BillPayInput[], s: Settings): Promise<PayCalc[]> {
  const bankIds = [...new Set(payments.flatMap((p) => (p.mode === 'ONLINE' ? [p.bankAccountId] : [])))];
  if (bankIds.length) {
    const have = new Set((await scopedDb(ctx).bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true } })).map((b) => b.id));
    for (const id of bankIds) if (!have.has(id)) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  }
  const jtIds = [...new Set(payments.flatMap((p) => (p.mode === 'METAL' && p.jewelleryTypeId != null ? [p.jewelleryTypeId] : [])))];
  if (jtIds.length) {
    // global list (businessId null) or this business's own types
    const have = new Set((await prisma.jewelleryType.findMany({ where: { id: { in: jtIds }, OR: [{ businessId: null }, { businessId: ctx.businessId! }] }, select: { id: true } })).map((t) => t.id));
    for (const id of jtIds) if (!have.has(id)) throw new HttpError(404, 'NOT_FOUND', 'Jewellery type not found');
  }
  return payments.map((p): PayCalc => {
    if (p.mode === 'CASH') return { input: p, amount: String(p.amount) };
    if (p.mode === 'ONLINE') return { input: p, amount: String(p.amount), bankAccountId: p.bankAccountId };
    if (p.mode === 'SCHEME' || p.mode === 'UDHAR_ADVANCE') return { input: p, amount: String(p.amount) };
    const net = netWeight(p.gross, p.less);
    const fine = fineWeight(net, p.tunch, 0); // payments: no wastage
    return { input: p, amount: metalToMoney(fine, p.rate, metalUnitGrams(p.metal, s)), metal: p.metal, metalForm: p.metalForm, gross: p.gross, net: net.toFixed(3), fine: fine.toFixed(3), tunch: p.tunch, rate: p.rate };
  });
}

/** One ledger row per payment (CASH/ONLINE → MONEY, METAL → GOLD/SILVER). SELL = money/metal IN, PURCHASE = OUT. */
function paymentLedgerRow(pc: PayCalc, paymentId: number, billId: number, kind: BillKind, branchId: number, txnDate: Date): ledger.LedgerEntryInput {
  const direction = kind === 'SELL' ? 'IN' : 'OUT';
  const base = { branchId, txnDate, direction, source: billSource(kind), sourceId: `${billId}-P${paymentId}` } as const;
  if (pc.input.mode === 'METAL') return { ...base, asset: pc.metal!, metalForm: pc.metalForm, gross: pc.gross, net: pc.net, fine: pc.fine, amount: pc.amount, narration: 'Bill metal payment' };
  return { ...base, asset: 'MONEY', bankAccountId: pc.bankAccountId ?? null, amount: pc.amount, narration: 'Bill payment' };
}

export const sumAmounts = (pcs: PayCalc[]) => pcs.reduce((a, pc) => a.plus(D(pc.amount)), new Prisma.Decimal(0));

// ───────────── TASK-98 no-cash pay modes (SCHEME / UDHAR_ADVANCE) ─────────────

const isNoCash = (pc: PayCalc) => pc.input.mode === 'SCHEME' || pc.input.mode === 'UDHAR_ADVANCE';

/** Pre-tx: SELL bills only; each SCHEME enrollment in scope, this party's, used once; loads scheme + redeem rate onto the PayCalc. */
async function checkNoCashPays(ctx: TenantContext, kind: BillKind, partyId: number, payCalcs: PayCalc[]): Promise<void> {
  const special = payCalcs.filter(isNoCash);
  if (!special.length) return;
  if (kind !== 'SELL') throw new HttpError(400, 'VALIDATION', 'Scheme / udhar advance payments are for sell bills only');
  const seen = new Set<number>();
  for (const pc of special) {
    if (pc.input.mode !== 'SCHEME') continue;
    const enrollmentId = pc.input.enrollmentId;
    if (seen.has(enrollmentId)) throw new HttpError(400, 'VALIDATION', 'The same scheme enrollment is used twice');
    seen.add(enrollmentId);
    const e = await scopedDb(ctx).schemeEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
    if (e.partyId !== partyId) throw new HttpError(409, 'CONFLICT', 'Scheme enrollment belongs to another party');
    pc.enrollment = e;
    pc.scheme = await scopedDb(ctx).scheme.findUniqueOrThrow({ where: { id: e.schemeId } });
    pc.redeemRate = await redeemRateFor(ctx, pc.scheme);
  }
}

/**
 * In-tx effects of the no-cash payments on a SELL bill (no ledger row — nothing enters the shop):
 * UDHAR_ADVANCE uses the party's credit; SCHEME first redeems the enrollment (credit = maturity value, existing redeem path) and uses that.
 * Either way the bill takes `amount` of the party's credit: a +amount udhar row under sourceId `<billId>-A` (reversed by undoBill / deleteBill).
 * Over-balance → 409. The advance check excludes the bill's own `<billId>` rows (its outstanding is not credit) but counts earlier `-A` uses.
 */
async function postNoCashPays(tx: Prisma.TransactionClient, ctx: TenantContext, bill: { id: number; billNo: string; branchId: number; partyId: number }, payCalcs: PayCalc[], txnDate: Date, lctx: ledger.LedgerContext): Promise<void> {
  const special = payCalcs.filter(isNoCash);
  if (!special.length) return;
  await ledger.assertDaysOpen(tx, lctx, [{ branchId: bill.branchId, txnDate }]);
  const advance = special.filter((pc) => pc.input.mode === 'UDHAR_ADVANCE').reduce((a, pc) => a.plus(D(pc.amount)), new Prisma.Decimal(0));
  if (advance.gt(0)) {
    await tx.$queryRaw`SELECT id FROM "Party" WHERE id = ${bill.partyId} FOR UPDATE`; // serialize concurrent uses of the same credit
    const sum = await tx.udharEntry.aggregate({ where: { businessId: ctx.businessId!, partyId: bill.partyId, NOT: { source: 'SELL_BILL', sourceId: String(bill.id) } }, _sum: { amount: true } });
    const credit = Prisma.Decimal.max(D(sum._sum.amount).negated(), 0);
    if (advance.gt(credit)) throw new HttpError(409, 'CONFLICT', `Udhar advance available is ₹${credit.toFixed(2)}`, { code: 'OVER_BALANCE' });
  }
  for (const pc of special) {
    let narration = `${bill.billNo} udhar advance`;
    if (pc.input.mode === 'SCHEME') {
      const value = await redeemInTx(tx, ctx, pc.enrollment, pc.scheme, { early: 'auto', redeemRate: pc.redeemRate!, billId: bill.id });
      if (D(pc.amount).gt(value)) throw new HttpError(409, 'CONFLICT', `Scheme ${pc.enrollment.assignId} value is ₹${value.toFixed(2)}`, { code: 'OVER_BALANCE' });
      narration = `${bill.billNo} scheme ${pc.enrollment.assignId}`;
    }
    await udhar.post(tx, lctx, [{ branchId: bill.branchId, partyId: bill.partyId, txnDate, amount: D(pc.amount), source: 'SELL_BILL', sourceId: `${bill.id}-A`, narration }]);
  }
}

/** Bill delete / edit: reopen every enrollment the bill's active SCHEME payments redeemed. */
async function reopenSchemes(tx: Prisma.TransactionClient, ctx: TenantContext, bill: { id: number; payments: any[] }): Promise<void> {
  for (const p of bill.payments) if (p.mode === 'SCHEME' && p.isActive && p.schemeEnrollmentId != null) await reopenForBill(tx, ctx, p.schemeEnrollmentId, bill.id);
}

// ───────────── Line resolution ─────────────

interface ResolvedLine {
  input: BillBody['items'][number];
  action: 'SELL_TAG' | 'SELL_LOOSE' | 'SELL_DIRECT' | 'PURCHASE';
  stockClass: StockClass;
  description: string;
  hsnCode: string | null;
  tagNo: string | null;
  karatCode: string | null;
  groupId: number | null;
  itemNameId: number | null;
  pcs: number;
  gross: number;
  less: number;
  tunch: number;
  wastage: number;
  calc: ReturnType<typeof computeLine>;
  stockItem?: any;
  itemName?: any;
}

async function resolveLines(ctx: TenantContext, body: BillBody, branchId: number, s: Settings, allowSold: Set<number> = new Set()): Promise<ResolvedLine[]> {
  const sdb = scopedDb(ctx);
  const sellStockIds = body.kind === 'SELL' ? [...new Set(body.items.flatMap((l) => (l.stockItemId != null ? [l.stockItemId] : [])))] : [];
  const nameIds = [...new Set(body.items.flatMap((l) => (l.stockItemId == null && l.itemNameId != null ? [l.itemNameId] : [])))];
  const [stockItems, itemNames, karats] = await Promise.all([
    // allowSold = the editing bill's own items (still SOLD/reduced until the in-tx undo frees them); the in-tx guards remain authoritative.
    sellStockIds.length ? sdb.stockItem.findMany({ where: { id: { in: sellStockIds }, branchId, OR: [{ status: 'AVAILABLE' }, { id: { in: [...allowSold] } }] }, include: { itemName: true, group: true } }) : [],
    nameIds.length ? sdb.itemName.findMany({ where: { id: { in: nameIds } }, include: { group: true } }) : [],
    sdb.karatMapping.findMany({ select: { code: true, touch: true } }),
  ]);
  const stockById = new Map(stockItems.map((i) => [i.id, i]));
  const nameById = new Map(itemNames.map((n) => [n.id, n]));
  const touch = new Map(karats.map((k) => [k.code, Number(k.touch)]));
  const hsnIds = [...new Set([...stockItems.flatMap((i) => [i.itemName.hsnId, i.group.hsnId]), ...itemNames.flatMap((n) => [n.hsnId, n.group.hsnId])].filter((x): x is number => x != null))];
  const hsn = new Map((hsnIds.length ? await prisma.hsnCode.findMany({ where: { id: { in: hsnIds } }, select: { id: true, code: true } }) : []).map((h) => [h.id, h.code]));

  return body.items.map((line): ResolvedLine => {
    const basis = body.kind === 'SELL' ? s['calc.basis'].sale : s['calc.basis'].purchase;
    let r: Omit<ResolvedLine, 'calc'>;
    if (body.kind === 'SELL' && line.stockItemId != null) {
      const item = stockById.get(line.stockItemId);
      if (!item) throw new HttpError(409, 'CONFLICT', `Stock item ${line.stockItemId} is not AVAILABLE in this branch`);
      const cls = item.stockClass as StockClass;
      const hsnCode = (item.itemName.hsnId != null ? hsn.get(item.itemName.hsnId) : item.group.hsnId != null ? hsn.get(item.group.hsnId) : null) ?? null;
      const common = { stockClass: cls, description: item.itemName.name, hsnCode, tagNo: item.tagNo, karatCode: item.karatCode, groupId: item.groupId, itemNameId: item.itemNameId, tunch: Number(item.tunch), wastage: Number(item.wastage), stockItem: item };
      if (item.method === 'TAG') r = { input: line, action: 'SELL_TAG', pcs: item.pcs, gross: Number(item.gross), less: Number(item.less), ...common };
      else {
        if (!allowSold.has(item.id) && (line.gross > Number(item.gross) || line.less > Number(item.less) || line.pcs > item.pcs)) throw new HttpError(409, 'CONFLICT', `Stock item ${item.id} does not hold that much`);
        r = { input: line, action: 'SELL_LOOSE', pcs: line.pcs, gross: line.gross, less: line.less, ...common };
      }
    } else if (body.kind === 'PURCHASE') {
      if (line.itemNameId == null) throw new HttpError(400, 'VALIDATION', 'Purchase line needs itemNameId');
      const name = nameById.get(line.itemNameId);
      if (!name) throw new HttpError(404, 'NOT_FOUND', 'Item name not found');
      const karatCode = line.karatCode ?? name.defKaratCode ?? null;
      const hsnCode = (name.hsnId != null ? hsn.get(name.hsnId) : name.group.hsnId != null ? hsn.get(name.group.hsnId) : null) ?? null;
      r = { input: line, action: 'PURCHASE', stockClass: name.group.stockClass, description: name.name, hsnCode, tagNo: line.tagNo ?? null, karatCode, groupId: name.groupId, itemNameId: name.id, pcs: line.pcs, gross: line.gross, less: line.less, tunch: line.tunch ?? (karatCode ? touch.get(karatCode) : undefined) ?? (name.defTunch != null ? Number(name.defTunch) : undefined) ?? 100, wastage: line.wastage, itemName: name };
    } else {
      // SELL direct line (no stock movement)
      const name = line.itemNameId != null ? nameById.get(line.itemNameId) : undefined;
      if (line.itemNameId != null && !name) throw new HttpError(404, 'NOT_FOUND', 'Item name not found');
      if (!name && (!line.description || !line.stockClass)) throw new HttpError(400, 'VALIDATION', 'Direct line needs itemNameId or description + stockClass');
      const karatCode = line.karatCode ?? name?.defKaratCode ?? null;
      const hsnCode = name ? ((name.hsnId != null ? hsn.get(name.hsnId) : name.group.hsnId != null ? hsn.get(name.group.hsnId) : null) ?? null) : null;
      r = { input: line, action: 'SELL_DIRECT', stockClass: (name ? name.group.stockClass : line.stockClass!) as StockClass, description: name ? name.name : line.description!, hsnCode, tagNo: line.tagNo ?? null, karatCode, groupId: name?.groupId ?? null, itemNameId: name?.id ?? null, pcs: line.pcs, gross: line.gross, less: line.less, tunch: line.tunch ?? (karatCode ? touch.get(karatCode) : undefined) ?? (name?.defTunch != null ? Number(name.defTunch) : undefined) ?? 100, wastage: line.wastage, itemName: name };
    }
    const calc = computeLine({ pcs: r.pcs, gross: r.gross, less: r.less, tunch: r.tunch, wastage: r.wastage, stoneCharge: line.stoneCharge, rate: line.rate, rateUnitGrams: rateUnitGrams(r.stockClass, body.kind, s), labour: line.labour, labourUnit: line.labourUnit, other: line.other, discount: line.discount, discountUnit: line.discountUnit, basis });
    return { ...r, calc };
  });
}

// ───────────── Create ─────────────

export async function nextBillNo(ctx: TenantContext, q: { kind: BillKind; billType: BillType }): Promise<{ billNo: string }> {
  const branchId = activeBranch(ctx);
  const s = await getSettings(ctx);
  const numbering = s[q.kind === 'SELL' ? 'invoice.sale' : 'invoice.purchase'];
  const date = ledger.businessDate();
  const key = docKey(q.kind, q.billType, numbering, date);
  const row = await prisma.docSequence.findUnique({ where: { businessId_branchId_key: { businessId: ctx.businessId!, branchId, key } } });
  const seq = row ? row.next : seriesStart(q.billType, numbering);
  return { billNo: formatBillNo(seq, q.billType, numbering, date) };
}

interface Prepared {
  party: any;
  interState: boolean;
  lines: ResolvedLine[];
  payCalcs: PayCalc[];
  paid: Prisma.Decimal;
  billCalc: ReturnType<typeof computeBill>;
  bal: Prisma.Decimal;
  keepWeight: string | null;
  /** grams per keepRate unit used for keepWeight (null on MONEY) */
  keepUnitGrams: number | null;
  billDate: Date;
  dueDate: Date | null;
}

/** Pre-tx read + validation shared by create and edit: party, interState, recomputed lines/payments, PAN + rate-limit checks, totals, keep weight, dates. */
async function prepareBill(ctx: TenantContext, body: BillBody, branchId: number, s: Settings, allowSold: Set<number> = new Set(), storedKeepUnit?: number): Promise<Prepared> {
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const branch = await sdb.branch.findUnique({ where: { id: branchId }, select: { stateId: true } });
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId! }, select: { stateId: true } });
  const branchState = branch?.stateId ?? business?.stateId ?? null;
  const interState = party.stateId != null && branchState != null && party.stateId !== branchState;

  const lines = await resolveLines(ctx, body, branchId, s, allowSold);
  const payCalcs = await computePayments(ctx, body.payments, s);
  await checkNoCashPays(ctx, body.kind, party.id, payCalcs);
  const paid = sumAmounts(payCalcs);

  if (body.kind === 'SELL') {
    // PAN rule: a big cash receipt needs the party's PAN.
    const cash = payCalcs.filter((p) => p.input.mode === 'CASH').reduce((a, p) => a.plus(D(p.amount)), new Prisma.Decimal(0));
    if (cash.gte(PAN_CASH_LIMIT) && !party.pan && !body.pan) throw new HttpError(400, 'VALIDATION', 'PAN required for this cash amount', { code: 'PAN_REQUIRED' });
    // Rate limits on GOLD/SILVER lines.
    const limits = await sdb.rateLimit.findMany({});
    lines.forEach((r, i) => {
      if ((r.stockClass === 'GOLD' || r.stockClass === 'SILVER') && Number(r.input.rate) > 0) {
        const unit = r.stockClass === 'GOLD' ? s['rates.units'].gold : s['rates.units'].silver;
        const lim = limits.find((l) => l.metal === r.stockClass && l.rateUnit === unit);
        if (lim && (D(r.input.rate).lt(lim.minRate) || D(r.input.rate).gt(lim.maxRate))) throw new HttpError(400, 'VALIDATION', 'Rate outside the allowed limit', { code: 'RATE_LIMIT', line: i });
      }
    });
  }

  const numbering = s[body.kind === 'SELL' ? 'invoice.sale' : 'invoice.purchase'];
  const gstExempt = numbering.gstOnRemainingMetal ? payCalcs.filter((p) => p.input.mode === 'METAL').reduce((a, p) => a.plus(D(p.amount)), new Prisma.Decimal(0)) : new Prisma.Decimal(0);
  const billCalc = computeBill({ lineTotals: lines.map((r) => r.calc.total), discount: body.discount, discountUnit: body.discountUnit, gstPercent: body.billType === 'ROUGH' ? 0 : body.gstPercent, interState, gstExemptAmount: gstExempt, roundTo: 1 });
  const bal = D(billCalc.final).minus(paid);
  // BILL-15 R2: an edit keeps the unit the bill was saved with; a new keep uses the current shop unit
  const keepUnitGrams = body.keepBalanceAs === 'MONEY' ? null : (storedKeepUnit ?? metalUnitGrams(body.keepBalanceAs, s));
  const keepWeight = bal.gt(0) && keepUnitGrams != null ? moneyToMetal(bal, body.keepRate!, keepUnitGrams) : null;
  return { party, interState, lines, payCalcs, paid, billCalc, bal, keepWeight, keepUnitGrams, billDate: ledger.businessDate(body.billDate ?? new Date()), dueDate: body.dueDate ? ledger.businessDate(body.dueDate) : null };
}

/** The line/stock/ledger/payment/udhar writes applied onto an existing Bill row (no numbering) — shared by create and edit. Carries the TASK-30b in-tx concurrency guards. */
async function writeBillContents(tx: Prisma.TransactionClient, ctx: TenantContext, bill: { id: number; branchId: number; billNo: string; billDate: Date }, body: BillBody, prep: Prepared, lctx: ledger.LedgerContext, reservedIds: Set<number> = new Set()): Promise<void> {
  const { id: billId, branchId, billNo, billDate } = bill;
  if (body.pan && !prep.party.pan) await tx.party.update({ where: { id: prep.party.id }, data: { pan: body.pan } });
  // An order's finished pieces are RESERVED-for-this-order; the claim accepts RESERVED only for those ids, everything else AVAILABLE only.
  const sellable = (itemId: number) => (reservedIds.has(itemId) ? (['AVAILABLE', 'RESERVED'] as const) : (['AVAILABLE'] as const));

  const stockLedger: ledger.LedgerEntryInput[] = [];
  for (const r of prep.lines) {
    let stockItemId: number | null = null;
    if (r.action === 'SELL_TAG') {
      const sold = await tx.stockItem.updateMany({ where: { id: r.stockItem.id, status: { in: [...sellable(r.stockItem.id)] }, branchId }, data: { status: 'SOLD' } });
      if (sold.count !== 1) throw new HttpError(409, 'CONFLICT', `Stock item ${r.stockItem.id} is no longer AVAILABLE`);
      stockItemId = r.stockItem.id;
    } else if (r.action === 'SELL_LOOSE') {
      const taken = await tx.stockItem.updateMany({ where: { id: r.stockItem.id, status: { in: [...sellable(r.stockItem.id)] }, gross: { gte: r.gross }, less: { gte: r.less }, pcs: { gte: r.pcs } }, data: { gross: { decrement: r.gross }, less: { decrement: r.less }, pcs: { decrement: r.pcs } } });
      if (taken.count !== 1) throw new HttpError(409, 'CONFLICT', `Stock item ${r.stockItem.id} does not hold that much`);
      const it = await tx.stockItem.findUniqueOrThrow({ where: { id: r.stockItem.id } });
      const net = Prisma.Decimal.max(D(it.gross).minus(it.less), 0);
      const fine = net.times(D(it.tunch)).div(100).times(D(it.wastage).div(100).plus(1));
      await tx.stockItem.update({ where: { id: it.id }, data: { net, fine, status: D(it.gross).lte(0) ? 'SOLD' : 'AVAILABLE' } });
      stockItemId = it.id;
    } else if (r.action === 'PURCHASE') {
      const method = r.input.tagNo || r.itemName.method === 'TAG' ? 'TAG' : 'LOOSE';
      const tagNo = method === 'TAG' ? (r.input.tagNo ?? (r.itemName.tagPrefix && r.itemName.tagDigits ? await nextTagNo(tx, ctx.businessId!, r.itemName.tagPrefix, r.itemName.tagDigits) : null)) : null;
      // TASK-98 "default sale value": optional sale rate/labour go onto the stock item only; purchaseCost stays the bill line total.
      const created = await tx.stockItem.create({
        data: {
          businessId: ctx.businessId!, branchId, stockClass: r.stockClass, groupId: r.itemName.groupId, itemNameId: r.itemName.id, method, tagNo, huid: r.input.huid ?? null, karatCode: r.karatCode,
          pcs: r.pcs, gross: r.gross, less: r.less, net: r.calc.net, tunch: r.tunch, wastage: r.wastage, fine: r.calc.fine, stoneCharge: r.input.stoneCharge, labour: r.input.saleLabour ?? r.input.labour,
          labourUnit: r.input.saleLabourUnit ?? r.input.labourUnit, other: r.input.other, rate: r.input.saleRate ?? (r.input.rate || null), purchaseCost: r.calc.total, status: 'AVAILABLE', source: 'PURCHASE_BILL', sourceId: String(billId), createdById: ctx.userId,
          remarks: r.input.remarks ?? null, ...(r.input.epcCode ? { codeType: 'RFID' as const, epcCode: r.input.epcCode } : {}),
          // INV-12: stone elements; with rows, stoneCharge above is already their total (withStoneCharges)
          ...(r.input.stones?.length ? { stones: { create: r.input.stones.map((st) => ({ businessId: ctx.businessId!, ...st })) } } : {}),
        },
      });
      stockItemId = created.id;
    }
    await tx.billItem.create({
      data: {
        billId, stockItemId, itemNameId: r.itemNameId, groupId: r.groupId, stockClass: r.stockClass, description: r.description, hsnCode: r.hsnCode, tagNo: r.tagNo, karatCode: r.karatCode,
        pcs: r.pcs, gross: r.gross, less: r.less, net: r.calc.net, tunch: r.tunch, wastage: r.wastage, fine: r.calc.fine, stoneCharge: r.input.stoneCharge, rate: r.input.rate, labour: r.input.labour,
        labourUnit: r.input.labourUnit, other: r.input.other, discount: r.input.discount, discountUnit: r.input.discountUnit, metalAmount: r.calc.metalAmount, labourAmount: r.calc.labourAmount, total: r.calc.total,
        ...(body.kind === 'PURCHASE' ? { supplierItem: r.input.supplierItem || null, supplierTag: r.input.supplierTag || null } : {}),
      },
    });
    if (stockItemId != null) {
      stockLedger.push({ branchId, txnDate: billDate, asset: ledger.assetForStockClass(r.stockClass), direction: body.kind === 'SELL' ? 'OUT' : 'IN', karatCode: r.karatCode, pcs: r.pcs, gross: r.gross, net: r.calc.net, fine: r.calc.fine, amount: r.calc.total, source: billSource(body.kind), sourceId: String(billId), stockItemId, narration: `${body.kind === 'SELL' ? 'Sold on' : 'Purchased on'} ${billNo}` });
    }
  }
  if (stockLedger.length) await ledger.post(tx, lctx, stockLedger);

  await postNoCashPays(tx, ctx, { id: billId, billNo, branchId, partyId: prep.party.id }, prep.payCalcs, billDate, lctx);
  for (const pc of prep.payCalcs) {
    const pay = await tx.billPayment.create({ data: { billId, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, schemeEnrollmentId: pc.enrollment?.id ?? null, jewelleryTypeId: pc.input.mode === 'METAL' ? pc.input.jewelleryTypeId ?? null : null, txnDate: billDate, isActive: true, createdById: ctx.userId } });
    if (!isNoCash(pc)) await ledger.post(tx, lctx, [paymentLedgerRow(pc, pay.id, billId, body.kind, branchId, billDate)]);
  }

  if (!prep.bal.isZero()) {
    const sign = body.kind === 'SELL' ? 1 : -1;
    const entry: udhar.UdharEntryInput = { branchId, partyId: prep.party.id, txnDate: billDate, source: billSource(body.kind), sourceId: String(billId), narration: billNo };
    if (prep.keepWeight != null) {
      if (body.keepBalanceAs === 'GOLD') entry.gold = D(prep.keepWeight).times(sign);
      else entry.silver = D(prep.keepWeight).times(sign);
    } else entry.amount = prep.bal.times(sign);
    await udhar.post(tx, lctx, [entry]);
  }
}

/** Reverse a bill's effects, keeping the Bill row: payment ledger + udhar always; stock ledger + stock restore only when returnStock. Shared by delete and edit. */
async function undoBill(tx: Prisma.TransactionClient, ctx: TenantContext, bill: any, lctx: ledger.LedgerContext, returnStock: boolean): Promise<void> {
  await reopenSchemes(tx, ctx, bill);
  await tx.billPayment.updateMany({ where: { billId: bill.id }, data: { isActive: false } });
  for (const p of bill.payments) await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: `${bill.id}-P${p.id}` });
  await udhar.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(bill.id) });
  await udhar.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: `${bill.id}-A` }); // TASK-98 advance / scheme uses
  if (!returnStock) return;
  await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(bill.id) }); // stock rows
  if (bill.kind === 'PURCHASE') {
    const ids = bill.items.map((i: any) => i.stockItemId).filter((x: any): x is number => x != null);
    if (ids.length) {
      // edit only (undoBill's sole caller): the re-created items take the same tag no. / RFID EPC, both unique per business
      const del = await tx.stockItem.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'DELETED', tagNo: null, epcCode: null } });
      if (del.count !== ids.length) throw new HttpError(409, 'CONFLICT', 'A purchased item is no longer available — cannot return stock');
    }
    return;
  }
  for (const it of bill.items) {
    if (it.stockItemId == null) continue;
    const stock = await tx.stockItem.findUnique({ where: { id: it.stockItemId } });
    if (!stock) continue;
    if (stock.method === 'LOOSE') {
      const g = D(stock.gross).plus(it.gross);
      const l = D(stock.less).plus(it.less);
      const net = Prisma.Decimal.max(g.minus(l), 0);
      const fine = net.times(D(stock.tunch)).div(100).times(D(stock.wastage).div(100).plus(1));
      await tx.stockItem.update({ where: { id: stock.id }, data: { gross: g, less: l, pcs: stock.pcs + it.pcs, net, fine, status: 'AVAILABLE' } });
    } else await tx.stockItem.update({ where: { id: stock.id }, data: { status: 'AVAILABLE' } });
  }
}

/** TASK-97 GST reporting fields — stored only (no calc/posting effect); omitted → schema default on create, unchanged on edit. */
const gstMeta = (b: BillBody) => ({
  itcEligibility: b.itcEligibility,
  itcBlockReason: b.itcBlockReason === undefined ? undefined : b.itcBlockReason || null,
  supplierInvoiceNo: b.supplierInvoiceNo === undefined ? undefined : b.supplierInvoiceNo || null,
  supplyCategory: b.supplyCategory,
  reverseCharge: b.reverseCharge,
});

/** INV-12: on a purchase line with stone rows the stone charge is their total (it then counts once, in computeLine); without rows the typed charge stands. */
const withStoneCharges = (body: BillBody): BillBody =>
  body.kind !== 'PURCHASE' ? body : { ...body, items: body.items.map((l) => (l.stones?.length ? { ...l, stoneCharge: Number(stoneTotal(l.stones.map((st) => st.amount))) } : l)) };

export async function createBill(ctx: TenantContext, body: BillBody): Promise<BillDto> {
  body = withStoneCharges(body);
  const branchId = activeBranch(ctx);
  const s = await getSettings(ctx);
  const numbering = s[body.kind === 'SELL' ? 'invoice.sale' : 'invoice.purchase'];
  const lctx = lctxOf(ctx);

  // Phase 8: billing an order — its READY order's finished (RESERVED) pieces become sellable on this bill; validate up-front, flip in the tx.
  let reservedIds = new Set<number>();
  if (body.orderId != null) {
    if (body.kind !== 'SELL') throw new HttpError(400, 'VALIDATION', 'An order can only be billed as a sell bill');
    const order = await scopedDb(ctx).order.findFirst({ where: { id: body.orderId }, include: { items: { select: { stockItemId: true } } } });
    if (!order || order.partyId !== body.partyId || order.status !== 'READY') throw new HttpError(409, 'CONFLICT', 'Order is not READY for this party');
    reservedIds = new Set(order.items.map((i) => i.stockItemId).filter((x): x is number => x != null));
  }
  const prep = await prepareBill(ctx, body, branchId, s, reservedIds);

  // Phase 7: billing from an approved showroom draft — validate up-front (friendly 409), flip it atomically in the tx.
  if (body.draftId != null) {
    if (body.kind !== 'SELL') throw new HttpError(400, 'VALIDATION', 'A draft can only be billed as a sell bill');
    const draft = await scopedDb(ctx).salesDraft.findFirst({ where: { id: body.draftId }, select: { status: true, branchId: true, expiresAt: true } });
    if (!draft || draft.status !== 'APPROVED' || draft.branchId !== branchId || draft.expiresAt < new Date()) throw new HttpError(409, 'CONFLICT', 'Draft is not approved and active in this branch');
  }

  const billId = await prisma.$transaction(async (tx) => {
    const key = docKey(body.kind, body.billType, numbering, prep.billDate);
    const start = seriesStart(body.billType, numbering);
    const seqRow = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, ${key}, ${start + 1})
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const seq = Number(seqRow[0]!.next) - 1;
    const billNo = formatBillNo(seq, body.billType, numbering, prep.billDate);
    const bill = await tx.bill.create({
      data: {
        businessId: ctx.businessId!, branchId, kind: body.kind, billType: body.billType, billNo, seq, partyId: prep.party.id, billDate: prep.billDate,
        dueDate: prep.dueDate, interState: prep.interState,
        sub: prep.billCalc.sub, discount: body.discount, discountUnit: body.discountUnit, discountAmount: prep.billCalc.discountAmount,
        gstPercent: body.billType === 'ROUGH' ? 0 : body.gstPercent, taxable: prep.billCalc.taxable, cgst: prep.billCalc.cgst, sgst: prep.billCalc.sgst, igst: prep.billCalc.igst,
        total: prep.billCalc.total, round: prep.billCalc.round, final: prep.billCalc.final, paid: prep.paid, keepBalanceAs: body.keepBalanceAs,
        keepRate: body.keepBalanceAs !== 'MONEY' ? (body.keepRate ?? null) : null, keepWeight: prep.keepWeight, keepRateUnitGrams: prep.keepUnitGrams, remark: body.remark ?? null, status: 'ACTIVE', createdById: ctx.userId,
        ...gstMeta(body),
      },
    });
    await writeBillContents(tx, ctx, bill, body, prep, lctx, reservedIds);
    if (body.draftId != null) {
      const flip = await tx.salesDraft.updateMany({ where: { id: body.draftId, status: 'APPROVED' }, data: { status: 'BILLED', billId: bill.id } });
      if (flip.count !== 1) throw new HttpError(409, 'CONFLICT', 'Draft has already been billed');
    }
    if (body.orderId != null) {
      const flip = await tx.order.updateMany({ where: { id: body.orderId, status: 'READY' }, data: { status: 'DELIVERED', billId: bill.id } });
      if (flip.count !== 1) throw new HttpError(409, 'CONFLICT', 'Order has already been billed');
      await tx.orderItem.updateMany({ where: { orderId: body.orderId }, data: { status: 'DELIVERED' } });
    }
    await logActivity(tx, ctx, { module: body.kind, action: 'CREATED', entity: 'BILL', entityId: String(bill.id), summary: `${body.kind === 'SELL' ? 'Sell' : 'Purchase'} bill ${billNo} ₹${prep.billCalc.final}`, partyName: prep.party.name });
    return bill.id;
  });

  return getBill(ctx, billId);
}

/** Edit a saved bill (today only): undo it like delete-with-return but keep the row, then re-apply the body onto the same id/billNo/seq. */
export async function editBill(ctx: TenantContext, id: number, body: BillBody): Promise<BillDto> {
  body = withStoneCharges(body);
  const sdb = scopedDb(ctx);
  const bill = await sdb.bill.findFirst({ where: { id }, include: { items: true, payments: true } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
  if (bill.kind !== body.kind || bill.billType !== body.billType) throw new HttpError(400, 'VALIDATION', 'Cannot change a bill’s kind or type on edit');
  if (bill.billDate.getTime() !== ledger.businessDate().getTime()) throw new HttpError(400, 'VALIDATION', "Only today's bill can be edited — delete and re-create for a past day");
  const s = await getSettings(ctx);
  // This bill's own stock items are still SOLD/reduced until the in-tx undo; allow them when re-resolving the new lines.
  const ownStockIds = new Set(bill.items.map((i) => i.stockItemId).filter((x): x is number => x != null));
  // BILL-15 R6: a stored keep rate (or kept metal) changes only when the user confirms it; the change is logged below
  const rateChanged = bill.keepBalanceAs !== 'MONEY' && (body.keepBalanceAs !== bill.keepBalanceAs || !D(body.keepRate ?? 0).eq(D(bill.keepRate)));
  if (rateChanged && !body.keepRateChange) throw new HttpError(409, 'CONFLICT', 'This changes the bill’s stored keep rate — confirm the rate change', { code: 'KEEP_RATE_CHANGE' });
  // BILL-15 R2: same kept metal → the unit frozen on the bill (legacy rows without one: the current shop unit, as before)
  const storedUnit = body.keepBalanceAs === bill.keepBalanceAs && bill.keepRateUnitGrams != null ? Number(bill.keepRateUnitGrams) : undefined;
  const prep = await prepareBill(ctx, body, bill.branchId, s, ownStockIds, storedUnit);
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    // Lock the row + confirm still ACTIVE (TASK-30b-style guard against a concurrent edit/delete).
    const locked = await tx.bill.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'ACTIVE' } });
    if (locked.count !== 1) throw new HttpError(409, 'CONFLICT', 'Bill is not active');
    await undoBill(tx, ctx, bill, lctx, true); // undo old effects (always returns stock) before re-applying
    await tx.billItem.deleteMany({ where: { billId: id } });
    await tx.bill.update({
      where: { id },
      data: {
        partyId: prep.party.id, interState: prep.interState, dueDate: prep.dueDate,
        sub: prep.billCalc.sub, discount: body.discount, discountUnit: body.discountUnit, discountAmount: prep.billCalc.discountAmount,
        gstPercent: body.billType === 'ROUGH' ? 0 : body.gstPercent, taxable: prep.billCalc.taxable, cgst: prep.billCalc.cgst, sgst: prep.billCalc.sgst, igst: prep.billCalc.igst,
        total: prep.billCalc.total, round: prep.billCalc.round, final: prep.billCalc.final, paid: prep.paid, keepBalanceAs: body.keepBalanceAs,
        keepRate: body.keepBalanceAs !== 'MONEY' ? (body.keepRate ?? null) : null, keepWeight: prep.keepWeight, keepRateUnitGrams: prep.keepUnitGrams, remark: body.remark ?? null,
        ...gstMeta(body),
      },
    });
    await writeBillContents(tx, ctx, { id: bill.id, branchId: bill.branchId, billNo: bill.billNo, billDate: bill.billDate }, body, prep, lctx);
    await logActivity(tx, ctx, { module: bill.kind, action: 'EDITED', entity: 'BILL', entityId: String(id), summary: `Edited ${bill.kind === 'SELL' ? 'sell' : 'purchase'} bill ${bill.billNo} ₹${prep.billCalc.final}`, partyName: prep.party.name });
    if (rateChanged) {
      const was = { keepBalanceAs: bill.keepBalanceAs, keepRate: String(bill.keepRate), unitGrams: bill.keepRateUnitGrams != null ? String(bill.keepRateUnitGrams) : null };
      const now = { keepBalanceAs: body.keepBalanceAs, keepRate: body.keepBalanceAs !== 'MONEY' ? String(body.keepRate) : null, unitGrams: prep.keepUnitGrams != null ? String(prep.keepUnitGrams) : null };
      // user + timestamp are the activity row's own userId / createdAt
      await logActivity(tx, ctx, { module: bill.kind, action: 'EDITED', entity: 'BILL', entityId: String(id), summary: `Keep rate changed on ${bill.billNo}: ${was.keepBalanceAs} ₹${was.keepRate} → ${now.keepBalanceAs}${now.keepRate != null ? ` ₹${now.keepRate}` : ''}`, partyName: prep.party.name, meta: { change: 'KEEP_RATE', old: was, new: now } });
    }
  });
  return getBill(ctx, id);
}

// ───────────── Add payments ─────────────

export async function addBillPayments(ctx: TenantContext, id: number, body: { payments: BillPayInput[]; txnDate?: Date }): Promise<BillDto> {
  const sdb = scopedDb(ctx);
  const bill = await sdb.bill.findFirst({ where: { id } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
  const s = await getSettings(ctx);
  const payCalcs = await computePayments(ctx, body.payments, s);
  await checkNoCashPays(ctx, bill.kind, bill.partyId, payCalcs);
  const added = sumAmounts(payCalcs);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.bill.findUnique({ where: { id }, select: { status: true } });
    if (!fresh || fresh.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
    await postNoCashPays(tx, ctx, bill, payCalcs, txnDate, lctx);
    for (const pc of payCalcs) {
      const pay = await tx.billPayment.create({ data: { billId: id, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, schemeEnrollmentId: pc.enrollment?.id ?? null, jewelleryTypeId: pc.input.mode === 'METAL' ? pc.input.jewelleryTypeId ?? null : null, txnDate, isActive: true, createdById: ctx.userId } });
      if (!isNoCash(pc)) await ledger.post(tx, lctx, [paymentLedgerRow(pc, pay.id, id, bill.kind, bill.branchId, txnDate)]);
    }
    await tx.bill.update({ where: { id }, data: { paid: { increment: added } } }); // atomic — no lost update under concurrent payments
    if (!added.isZero()) {
      // Later payments always reduce the party's MONEY balance (SELL: party owes less; PURCHASE: shop owes less).
      await udhar.post(tx, lctx, [{ branchId: bill.branchId, partyId: bill.partyId, txnDate, source: billSource(bill.kind), sourceId: String(id), amount: added.times(bill.kind === 'SELL' ? -1 : 1), narration: `${bill.billNo} payment` }]);
    }
    await logActivity(tx, ctx, { module: bill.kind, action: 'EDITED', entity: 'BILL', entityId: String(id), summary: `Payment ₹${added.toFixed(2)} on ${bill.billNo}` });
  });
  return getBill(ctx, id);
}

// ───────────── Delete ─────────────

export async function deleteBill(ctx: TenantContext, id: number, returnStock: boolean): Promise<void> {
  const sdb = scopedDb(ctx);
  const bill = await sdb.bill.findFirst({ where: { id }, include: { items: true, payments: true } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    // Flip ACTIVE→DELETED atomically FIRST — two concurrent deletes can't both run the return (double stock).
    const flipped = await tx.bill.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'DELETED', deletedAt: new Date(), deletedWithStock: returnStock } });
    if (flipped.count !== 1) throw new HttpError(409, 'CONFLICT', 'Bill is not active');
    await reopenSchemes(tx, ctx, bill);
    await tx.billPayment.updateMany({ where: { billId: id }, data: { isActive: false } });
    for (const p of bill.payments) await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: `${id}-P${p.id}` });
    await udhar.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: `${id}-A` }); // TASK-98 advance / scheme uses

    if (returnStock) {
      await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(id) }); // stock rows
      if (bill.kind === 'PURCHASE') {
        // Availability check + delete in one atomic write: every created item must still be AVAILABLE.
        const ids = bill.items.map((i) => i.stockItemId).filter((x): x is number => x != null);
        if (ids.length) {
          const del = await tx.stockItem.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'DELETED', epcCode: null } }); // RFID EPC is unique per business: free it for re-use / the edit's re-created item
          if (del.count !== ids.length) throw new HttpError(409, 'CONFLICT', 'A purchased item is no longer available — cannot return stock');
        }
        await logActivity(tx, ctx, { module: bill.kind, action: 'DELETED', entity: 'BILL', entityId: String(id), summary: `Deleted purchase bill ${bill.billNo}` });
        return;
      }
      for (const it of bill.items) {
        if (it.stockItemId == null) continue;
        const stock = await tx.stockItem.findUnique({ where: { id: it.stockItemId } });
        if (!stock) continue;
        if (stock.method === 'LOOSE') {
          const g = D(stock.gross).plus(it.gross);
          const l = D(stock.less).plus(it.less);
          const net = Prisma.Decimal.max(g.minus(l), 0);
          const fine = net.times(D(stock.tunch)).div(100).times(D(stock.wastage).div(100).plus(1));
          await tx.stockItem.update({ where: { id: stock.id }, data: { gross: g, less: l, pcs: stock.pcs + it.pcs, net, fine, status: 'AVAILABLE' } });
        } else await tx.stockItem.update({ where: { id: stock.id }, data: { status: 'AVAILABLE' } });
      }
    }
    await logActivity(tx, ctx, { module: bill.kind, action: 'DELETED', entity: 'BILL', entityId: String(id), summary: `Deleted ${bill.kind === 'SELL' ? 'sell' : 'purchase'} bill ${bill.billNo}` });
  });
}

// ───────────── List / get + DTO mappers ─────────────

const lineDto = (i: any, stock?: Map<number, Pick<BillLineDto, 'huid' | 'epcCode' | 'remarks' | 'stones'>>): BillLineDto => ({
  id: i.id, stockItemId: i.stockItemId, itemNameId: i.itemNameId, stockClass: i.stockClass, description: i.description, hsnCode: i.hsnCode, tagNo: i.tagNo, karatCode: i.karatCode,
  pcs: i.pcs, gross: String(i.gross), less: String(i.less), net: String(i.net), tunch: String(i.tunch), wastage: String(i.wastage), fine: String(i.fine), stoneCharge: String(i.stoneCharge),
  rate: String(i.rate), labour: String(i.labour), labourUnit: i.labourUnit, other: String(i.other), discount: String(i.discount), discountUnit: i.discountUnit, metalAmount: String(i.metalAmount), labourAmount: String(i.labourAmount), total: String(i.total),
  supplierItem: i.supplierItem ?? null, supplierTag: i.supplierTag ?? null,
  ...(stock && i.stockItemId != null && stock.has(i.stockItemId) ? stock.get(i.stockItemId) : {}),
});

const paymentDto = (p: any, baMap: Map<number, string>, jtMap: Map<number, string>): BillPaymentDto => ({
  id: p.id, mode: p.mode, bankAccount: p.bankAccountId != null ? { id: p.bankAccountId, name: baMap.get(p.bankAccountId) ?? '' } : null, metal: p.metal, metalForm: p.metalForm,
  gross: p.gross != null ? String(p.gross) : null, net: p.net != null ? String(p.net) : null, tunch: p.tunch != null ? String(p.tunch) : null, fine: p.fine != null ? String(p.fine) : null, rate: p.rate != null ? String(p.rate) : null,
  amount: String(p.amount), remark: p.remark, schemeEnrollmentId: p.schemeEnrollmentId ?? null,
  jewelleryType: p.jewelleryTypeId != null ? { id: p.jewelleryTypeId, name: jtMap.get(p.jewelleryTypeId) ?? '' } : null, txnDate: p.txnDate.toISOString().slice(0, 10), isActive: p.isActive, createdAt: p.createdAt.toISOString(),
});

const listItemFields = (b: any, party: PartyRefDto, branchName: string, createdBy: string | null): BillListItemDto => ({
  id: b.id, kind: b.kind, billType: b.billType, billNo: b.billNo, billDate: b.billDate.toISOString().slice(0, 10), party, branch: { id: b.branchId, name: branchName },
  itemCount: b._count?.items ?? b.items?.length ?? 0, final: String(b.final), paid: String(b.paid), balance: D(b.final).minus(b.paid).toFixed(2), keepBalanceAs: b.keepBalanceAs,
  keepWeight: b.keepWeight != null ? String(b.keepWeight) : null, status: b.status, createdBy, createdAt: b.createdAt.toISOString(),
});

const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });

async function userNames(ctx: TenantContext, ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: uniq }, businessId: ctx.businessId! }, select: { id: true, name: true } });
  return new Map(rows.map((u) => [u.id, u.name]));
}

/** The bill's kind, scoped — for route-level per-kind permission gating (sell_bill vs purchase_bill). 404 if not visible. */
export async function billKind(ctx: TenantContext, id: number): Promise<BillKind> {
  const bill = await scopedDb(ctx).bill.findFirst({ where: { id }, select: { kind: true } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  return bill.kind;
}

export async function getBill(ctx: TenantContext, id: number): Promise<BillDto> {
  const bill = await scopedDb(ctx).bill.findFirst({ where: { id }, include: { items: { orderBy: { id: 'asc' } }, payments: { orderBy: { id: 'asc' } } } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: bill.partyId } });
  const branch = await sdb.branch.findUnique({ where: { id: bill.branchId }, select: { name: true } });
  const creator = (await userNames(ctx, bill.createdById != null ? [bill.createdById] : [])).get(bill.createdById!) ?? null;
  const baIds = [...new Set(bill.payments.map((p) => p.bankAccountId).filter((x): x is number => x != null))];
  const baMap = new Map((baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : []).map((b) => [b.id, b.bankName]));
  // PURCHASE: the created stock items' HUID / RFID / remark / stones, so an edit (which re-creates the stock) keeps them
  const stockIds = bill.kind === 'PURCHASE' ? bill.items.map((i) => i.stockItemId).filter((x): x is number => x != null) : [];
  const stockMap = new Map((stockIds.length ? await sdb.stockItem.findMany({ where: { id: { in: stockIds } }, select: { id: true, huid: true, epcCode: true, remarks: true, stones: { orderBy: { id: 'asc' } } } }) : []).map(({ id: sid, stones, ...rest }) => [sid, { ...rest, stones: stones.map(stoneDto) }]));
  const jtIds = [...new Set(bill.payments.map((p) => p.jewelleryTypeId).filter((x): x is number => x != null))];
  const jtMap = new Map((jtIds.length ? await prisma.jewelleryType.findMany({ where: { id: { in: jtIds } }, select: { id: true, name: true } }) : []).map((t) => [t.id, t.name]));
  return {
    ...listItemFields(bill, partyRef(party), branch?.name ?? '', creator),
    dueDate: bill.dueDate ? bill.dueDate.toISOString().slice(0, 10) : null, interState: bill.interState, sub: String(bill.sub), discount: String(bill.discount), discountUnit: bill.discountUnit, discountAmount: String(bill.discountAmount),
    gstPercent: String(bill.gstPercent), taxable: String(bill.taxable), cgst: String(bill.cgst), sgst: String(bill.sgst), igst: String(bill.igst), total: String(bill.total), round: String(bill.round),
    keepRate: bill.keepRate != null ? String(bill.keepRate) : null, keepRateUnitGrams: bill.keepRateUnitGrams != null ? String(bill.keepRateUnitGrams) : null, remark: bill.remark, deletedWithStock: bill.deletedWithStock,
    itcEligibility: bill.itcEligibility, itcBlockReason: bill.itcBlockReason, supplierInvoiceNo: bill.supplierInvoiceNo, supplyCategory: bill.supplyCategory, reverseCharge: bill.reverseCharge,
    items: bill.items.map((i) => lineDto(i, stockMap)), payments: bill.payments.map((p) => paymentDto(p, baMap, jtMap)),
  };
}

export async function listBills(ctx: TenantContext, query: any): Promise<Paged<BillListItemDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { kind: query.kind, status: query.status, ...(query.billType ? { billType: query.billType } : {}), ...(query.partyId ? { partyId: query.partyId } : {}) };
  if (query.from || query.to) where.billDate = { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) };
  if (query.minTotal != null || query.maxTotal != null) where.final = { ...(query.minTotal != null ? { gte: query.minTotal } : {}), ...(query.maxTotal != null ? { lte: query.maxTotal } : {}) };
  // pending (final ≠ paid) is a column-to-column comparison; Prisma field references break through the scoped client ("_ref"),
  // so resolve the ids with a scoped raw query and filter by them. shortcut: fine at shop scale; revisit at 100k+ bills.
  if (query.pending === 'true' || query.pending === 'false') {
    const ids = ctx.branchIds.length === 0 ? [] : (await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM "Bill" WHERE "businessId" = ${ctx.businessId!} AND "branchId" IN (${Prisma.join(ctx.branchIds)}) AND "final" ${query.pending === 'true' ? Prisma.raw('<>') : Prisma.raw('=')} "paid"`)).map((r) => r.id);
    where.id = { in: ids };
  }
  if (query.q) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    where.OR = [{ billNo: { contains: query.q, mode: 'insensitive' } }, { partyId: { in: parties.map((p) => p.id) } }];
  }
  if (query.partyType) {
    // Bill has no party relation: resolve this type's party ids first (AND-ed with partyId / q above).
    const typed = await sdb.party.findMany({ where: { type: query.partyType }, select: { id: true } });
    where.AND = [...(where.AND ?? []), { partyId: { in: typed.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.bill.findMany({ where, include: { _count: { select: { items: true } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.bill.count({ where }),
  ]);
  const parties = new Map((await sdb.party.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.partyId))] } } })).map((p) => [p.id, p]));
  const branches = new Map((await sdb.branch.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.branchId))] } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  const users = await userNames(ctx, rows.map((b) => b.createdById).filter((x): x is number => x != null));
  return {
    items: rows.map((b) => listItemFields(b, partyRef(parties.get(b.partyId)), branches.get(b.branchId) ?? '', b.createdById != null ? (users.get(b.createdById) ?? null) : null)),
    total, page: query.page, pageSize: query.pageSize,
  };
}

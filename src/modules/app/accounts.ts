import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import * as ledger from '../../lib/ledger';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { IE_SOURCE_TYPES, LEDGER_ASSETS } from '../../shared';
import type { AssetTotalsDto, DayBookAllInOneRowDto, DayBookDayDto, DayBookDto, IncomeExpenseDailySummaryDto, IncomeExpenseDto, LedgerAsset, OldMetalSummaryRowDto, LedgerPageDto, LedgerRowDto, LedgerSource, Paged } from '../../shared';

type IeSourceType = (typeof IE_SOURCE_TYPES)[number];
// TASK-81: which ledger sources each IE source-type surfaces. DIRECT = manual income/expense rows.
const IE_SOURCE_MAP: Record<IeSourceType, LedgerSource[]> = {
  DIRECT: ['INCOME_EXPENSE'],
  SELL_BILL: ['SELL_BILL', 'ORDER_SELL_BILL', 'SELL_BILL_STOCK_RETURN'],
  PURCHASE_BILL: ['PURCHASE_BILL', 'ORDER_PURCHASE_BILL', 'PURCHASE_BILL_STOCK_RETURN'],
  GIRVI: ['GIRVI'],
  UDHAR: ['UDHAR'],
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Main unit per asset for balances/totals (docs/api-phase3.md): MONEY = amount, metals = fine, counted stock = pcs. */
const UNIT: Record<LedgerAsset, 'amount' | 'fine' | 'pcs'> = { MONEY: 'amount', GOLD: 'fine', SILVER: 'fine', STONE: 'pcs', ARTIFICIAL: 'pcs', FRANCHISE: 'pcs' };

/** Admin with X-Branch-Id:all sees the whole subtree; otherwise just the active branch (own branch for branch users). */
const branchFilter = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);

const dec = (d: unknown): string | null => (d != null ? String(d) : null);
const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);
const dateWhere = (from?: Date, to?: Date) =>
  from || to ? { txnDate: { ...(from ? { gte: ledger.businessDate(from) } : {}), ...(to ? { lte: ledger.businessDate(to) } : {}) } } : {};

// ───────────── Income / Expense ─────────────

interface IeBody {
  type: 'INCOME' | 'EXPENSE';
  reason: string;
  cash: number;
  online: number;
  bankAccountId?: number;
  gold: number;
  silver: number;
  remark?: string;
  txnDate?: Date;
}

/** Ledger rows for one income/expense header (MONEY cash + online, GOLD/SILVER weight). INCOME→IN, EXPENSE→OUT. */
function ieLedgerRows(branchId: number, txnDate: Date, b: IeBody, sourceId: string): ledger.LedgerEntryInput[] {
  const direction = b.type === 'INCOME' ? 'IN' : 'OUT';
  const rows: ledger.LedgerEntryInput[] = [];
  if (b.cash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, amount: b.cash, source: 'INCOME_EXPENSE', sourceId, narration: b.reason });
  if (b.online > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, amount: b.online, bankAccountId: b.bankAccountId, source: 'INCOME_EXPENSE', sourceId, narration: b.reason });
  for (const [asset, wt] of [['GOLD', b.gold], ['SILVER', b.silver]] as const) {
    if (wt > 0) rows.push({ branchId, txnDate, asset, direction, metalForm: 'USUAL', gross: wt, net: wt, fine: wt, source: 'INCOME_EXPENSE', sourceId, narration: b.reason });
  }
  return rows;
}

async function decorateIE(ctx: TenantContext, rows: any[]): Promise<IncomeExpenseDto[]> {
  const sdb = scopedDb(ctx);
  const baIds = uniqIds(rows, 'bankAccountId');
  const banks = baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : [];
  const baName = new Map(banks.map((b) => [b.id, b.bankName]));
  const uName = await userNames(ctx, uniqIds(rows, 'createdById'));
  return rows.map((r) => ({
    id: r.id,
    txnDate: dateOnly(r.txnDate),
    type: r.type,
    reason: r.reason,
    cash: String(r.cash),
    online: String(r.online),
    bankAccount: r.bankAccountId != null ? { id: r.bankAccountId, name: baName.get(r.bankAccountId) ?? '' } : null,
    gold: String(r.gold),
    silver: String(r.silver),
    remark: r.remark,
    createdBy: r.createdById != null ? (uName.get(r.createdById) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    sourceType: 'DIRECT' as const,
  }));
}

export async function createIncomeExpense(ctx: TenantContext, body: IeBody): Promise<IncomeExpenseDto> {
  const branchId = ctx.activeBranchId ?? ctx.scopeBranchId;
  if (branchId == null || !ctx.branchIds.includes(branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const sdb = scopedDb(ctx);
  if (body.online > 0 && !(await sdb.bankAccount.findUnique({ where: { id: body.bankAccountId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = { businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId };

  const header = await prisma.$transaction(async (tx) => {
    const h = await tx.incomeExpense.create({
      data: { businessId: ctx.businessId!, branchId, txnDate, type: body.type, reason: body.reason, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, gold: body.gold, silver: body.silver, remark: body.remark ?? null, createdById: ctx.userId },
    });
    await ledger.post(tx, lctx, ieLedgerRows(branchId, txnDate, body, String(h.id)));
    await logActivity(tx, ctx, { module: 'INCOME_EXPENSE', action: 'CREATED', entity: 'IncomeExpense', entityId: String(h.id), summary: `${body.type}: ${body.reason}` });
    return h;
  });
  return (await decorateIE(ctx, [header]))[0]!;
}

type IeListQuery = { page: number; pageSize: number; q?: string; type?: 'INCOME' | 'EXPENSE'; from?: Date; to?: Date; sourceType?: IeSourceType };

const AUTO_SOURCE_TYPES = (Object.keys(IE_SOURCE_MAP) as IeSourceType[]).filter((s): s is Exclude<IeSourceType, 'DIRECT'> => s !== 'DIRECT');

export async function listIncomeExpense(ctx: TenantContext, query: IeListQuery): Promise<Paged<IncomeExpenseDto>> {
  const page = (all: IncomeExpenseDto[]): Paged<IncomeExpenseDto> =>
    ({ items: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: all.length, page: query.page, pageSize: query.pageSize });
  if (query.sourceType && query.sourceType !== 'DIRECT') return page(await autoEntries(ctx, query.sourceType, query)); // cross-module auto-entries, aggregated per document
  if (!query.sourceType) {
    // All sources: manual + every auto source, newest first.
    // shortcut: merged and paged in memory (like autoEntries) — fine at pilot scale; move to a SQL UNION if ledgers grow large.
    const [direct, ...auto] = await Promise.all([directEntries(ctx, query), ...AUTO_SOURCE_TYPES.map((st) => autoEntries(ctx, st, query))]);
    const all = [...direct, ...auto.flat()].sort((a, b) => b.txnDate.localeCompare(a.txnDate) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    return page(all);
  }
  const sdb = scopedDb(ctx);
  const where = directWhere(ctx, query);
  const [rows, total] = await Promise.all([
    sdb.incomeExpense.findMany({ where, orderBy: [{ txnDate: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.incomeExpense.count({ where }),
  ]);
  return { items: await decorateIE(ctx, rows), total, page: query.page, pageSize: query.pageSize };
}

function directWhere(ctx: TenantContext, query: IeListQuery): any {
  return {
    isDeleted: false, branchId: { in: branchFilter(ctx) }, ...(query.type ? { type: query.type } : {}), ...dateWhere(query.from, query.to),
    ...(query.q ? { OR: [{ reason: { contains: query.q, mode: 'insensitive' } }, { remark: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
}

async function directEntries(ctx: TenantContext, query: IeListQuery): Promise<IncomeExpenseDto[]> {
  const rows = await scopedDb(ctx).incomeExpense.findMany({ where: directWhere(ctx, query), orderBy: [{ txnDate: 'desc' }, { id: 'desc' }] });
  return decorateIE(ctx, rows);
}

const toDec = (x: Prisma.Decimal | null): Prisma.Decimal => new Prisma.Decimal(x ?? 0);
const IE_SOURCE_LABEL: Record<Exclude<IeSourceType, 'DIRECT'>, string> = { SELL_BILL: 'Sale', PURCHASE_BILL: 'Purchase', GIRVI: 'Girvi', UDHAR: 'Udhar' };

/** TASK-81: auto-entries from another module, one IncomeExpenseDto per source document (money net in `cash`, metals in gold/silver), newest first.
 *  shortcut: aggregates in memory (caller pages) — fine at pilot scale; move to a SQL rollup if a shop's ledger grows large. */
async function autoEntries(ctx: TenantContext, sourceType: Exclude<IeSourceType, 'DIRECT'>, query: IeListQuery): Promise<IncomeExpenseDto[]> {
  const base = { branchId: { in: branchFilter(ctx) }, source: { in: IE_SOURCE_MAP[sourceType] }, reversalOfId: null, ...dateWhere(query.from, query.to) };
  const rows = await scopedDb(ctx).ledgerEntry.groupBy({ by: ['sourceId', 'txnDate', 'asset', 'direction'], where: base, _sum: { amount: true, fine: true } });
  const docs = new Map<string, { sourceId: string; txnDate: Date; moneyIn: Prisma.Decimal; moneyOut: Prisma.Decimal; gold: Prisma.Decimal; silver: Prisma.Decimal }>();
  for (const r of rows) {
    const d = docs.get(r.sourceId) ?? { sourceId: r.sourceId, txnDate: r.txnDate, moneyIn: toDec(null), moneyOut: toDec(null), gold: toDec(null), silver: toDec(null) };
    if (r.asset === 'MONEY') { if (r.direction === 'IN') d.moneyIn = d.moneyIn.plus(toDec(r._sum.amount)); else d.moneyOut = d.moneyOut.plus(toDec(r._sum.amount)); }
    else if (r.asset === 'GOLD') d.gold = d.gold.plus(r.direction === 'IN' ? toDec(r._sum.fine) : toDec(r._sum.fine).neg());
    else if (r.asset === 'SILVER') d.silver = d.silver.plus(r.direction === 'IN' ? toDec(r._sum.fine) : toDec(r._sum.fine).neg());
    docs.set(r.sourceId, d);
  }
  let list = [...docs.values()].map((d) => ({ d, net: d.moneyIn.minus(d.moneyOut) }));
  if (query.type) list = list.filter(({ net }) => (query.type === 'INCOME' ? net.gte(0) : net.lt(0)));
  list.sort((a, b) => b.d.txnDate.getTime() - a.d.txnDate.getTime() || Number(b.d.sourceId) - Number(a.d.sourceId));
  const items: IncomeExpenseDto[] = list.map(({ d, net }) => ({
    id: Number(d.sourceId),
    txnDate: dateOnly(d.txnDate),
    type: net.gte(0) ? 'INCOME' : 'EXPENSE',
    reason: `${IE_SOURCE_LABEL[sourceType]} #${d.sourceId}`,
    cash: net.abs().toString(),
    online: '0',
    bankAccount: null,
    gold: d.gold.toString(),
    silver: d.silver.toString(),
    remark: null,
    createdBy: null,
    createdAt: dateOnly(d.txnDate),
    sourceType,
  }));
  const kw = query.q?.toLowerCase();
  return kw ? items.filter((i) => i.reason.toLowerCase().includes(kw)) : items;
}

/** TASK-81: per-day Cash In/Out, Profit (money IN−OUT) and Gold/Silver net, across all sources or one sourceType. */
export async function incomeExpenseDailySummary(ctx: TenantContext, query: { from?: Date; to?: Date; sourceType?: IeSourceType }): Promise<IncomeExpenseDailySummaryDto[]> {
  // no range given → last 30 days ending at `to` (one row per day), not just today
  const to = ledger.businessDate(query.to ?? new Date());
  const from = ledger.businessDate(query.from ?? new Date(to.getTime() - 29 * 86_400_000));
  const sdb = scopedDb(ctx);
  const base: any = { branchId: { in: branchFilter(ctx) }, reversalOfId: null, txnDate: { gte: from, lte: to }, ...(query.sourceType ? { source: { in: IE_SOURCE_MAP[query.sourceType] } } : {}) };
  const [money, cash, metal] = await Promise.all([
    sdb.ledgerEntry.groupBy({ by: ['txnDate', 'direction'], where: { ...base, asset: 'MONEY' }, _sum: { amount: true } }),
    sdb.ledgerEntry.groupBy({ by: ['txnDate', 'direction'], where: { ...base, asset: 'MONEY', bankAccountId: null }, _sum: { amount: true } }),
    sdb.ledgerEntry.groupBy({ by: ['txnDate', 'asset', 'direction'], where: { ...base, asset: { in: ['GOLD', 'SILVER'] } }, _sum: { fine: true } }),
  ]);
  const zero = () => toDec(null);
  type Day = { cashIn: Prisma.Decimal; cashOut: Prisma.Decimal; moneyIn: Prisma.Decimal; moneyOut: Prisma.Decimal; goldIn: Prisma.Decimal; goldOut: Prisma.Decimal; silverIn: Prisma.Decimal; silverOut: Prisma.Decimal };
  const days = new Map<string, Day>();
  const day = (d: Date): Day => { const k = dateOnly(d); let e = days.get(k); if (!e) { e = { cashIn: zero(), cashOut: zero(), moneyIn: zero(), moneyOut: zero(), goldIn: zero(), goldOut: zero(), silverIn: zero(), silverOut: zero() }; days.set(k, e); } return e; };
  for (const r of money) { const e = day(r.txnDate); if (r.direction === 'IN') e.moneyIn = e.moneyIn.plus(toDec(r._sum.amount)); else e.moneyOut = e.moneyOut.plus(toDec(r._sum.amount)); }
  for (const r of cash) { const e = day(r.txnDate); if (r.direction === 'IN') e.cashIn = e.cashIn.plus(toDec(r._sum.amount)); else e.cashOut = e.cashOut.plus(toDec(r._sum.amount)); }
  for (const r of metal) {
    const e = day(r.txnDate);
    const fine = toDec(r._sum.fine);
    if (r.asset === 'GOLD') { if (r.direction === 'IN') e.goldIn = e.goldIn.plus(fine); else e.goldOut = e.goldOut.plus(fine); }
    else if (r.direction === 'IN') e.silverIn = e.silverIn.plus(fine);
    else e.silverOut = e.silverOut.plus(fine);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, e]) => ({
      date, cashIn: e.cashIn.toString(), cashOut: e.cashOut.toString(), profit: e.moneyIn.minus(e.moneyOut).toString(),
      goldNet: e.goldIn.minus(e.goldOut).toString(), silverNet: e.silverIn.minus(e.silverOut).toString(),
      goldIn: e.goldIn.toString(), goldOut: e.goldOut.toString(), silverIn: e.silverIn.toString(), silverOut: e.silverOut.toString(),
    }));
}

export async function updateIncomeExpense(ctx: TenantContext, id: number, body: IeBody): Promise<IncomeExpenseDto> {
  const sdb = scopedDb(ctx);
  const h = await sdb.incomeExpense.findUnique({ where: { id } });
  if (!h || h.isDeleted) throw new HttpError(404, 'NOT_FOUND', 'Entry not found');
  // Only today's entries are editable; past days are corrected by delete + a fresh entry (keeps closed Day-Books intact).
  if (h.txnDate.getTime() !== ledger.businessDate().getTime()) throw new HttpError(400, 'VALIDATION', "Only today's entries can be edited — delete and re-enter for a past day");
  if (body.online > 0 && !(await sdb.bankAccount.findUnique({ where: { id: body.bankAccountId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  const txnDate = h.txnDate;
  const lctx = { businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId };

  await prisma.$transaction(async (tx) => {
    await tx.incomeExpense.update({ where: { id }, data: { type: body.type, reason: body.reason, cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, gold: body.gold, silver: body.silver, remark: body.remark ?? null } });
    await ledger.reverse(tx, lctx, { source: 'INCOME_EXPENSE', sourceId: String(id) });
    await ledger.post(tx, lctx, ieLedgerRows(h.branchId, txnDate, body, String(id)));
    await logActivity(tx, ctx, { module: 'INCOME_EXPENSE', action: 'EDITED', entity: 'IncomeExpense', entityId: String(id), summary: `${body.type}: ${body.reason}` });
  });
  return (await decorateIE(ctx, [await sdb.incomeExpense.findUniqueOrThrow({ where: { id } })]))[0]!;
}

export async function deleteIncomeExpense(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const h = await sdb.incomeExpense.findUnique({ where: { id } });
  if (!h || h.isDeleted) throw new HttpError(404, 'NOT_FOUND', 'Entry not found');
  const lctx = { businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId };
  await prisma.$transaction(async (tx) => {
    await tx.incomeExpense.update({ where: { id }, data: { isDeleted: true } });
    await ledger.reverse(tx, lctx, { source: 'INCOME_EXPENSE', sourceId: String(id) });
    await logActivity(tx, ctx, { module: 'INCOME_EXPENSE', action: 'DELETED', entity: 'IncomeExpense', entityId: String(id), summary: `${h.type}: ${h.reason}` });
  });
}

// ───────────── Asset ledgers (running balance via SQL window function) ─────────────

interface LedgerQ {
  page: number;
  pageSize: number;
  asset: LedgerAsset;
  from?: Date;
  to?: Date;
  source?: LedgerSource;
  direction?: 'IN' | 'OUT';
  bankAccountId?: number;
  metalForm?: 'USUAL' | 'BULLION' | 'KACHA';
  partyId?: number;
  stockItemId?: number;
  q?: string;
}

interface RawRow {
  id: bigint;
  txnDate: Date;
  createdAt: Date;
  branchId: number;
  source: string;
  sourceId: string;
  direction: 'IN' | 'OUT';
  partyId: number | null;
  bankAccountId: number | null;
  metalForm: 'USUAL' | 'BULLION' | 'KACHA' | null;
  karatCode: string | null;
  pcs: number | null;
  gross: Prisma.Decimal | null;
  net: Prisma.Decimal | null;
  fine: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  stockItemId: number | null;
  narration: string | null;
  reversalOfId: bigint | null;
  createdById: number | null;
  running: Prisma.Decimal;
}

/** Shared WHERE for a ledger query (asset + optional filters), minus the date window. */
function ledgerConds(ctx: TenantContext, q: LedgerQ, branches: number[]): Prisma.Sql[] {
  const c: Prisma.Sql[] = [
    Prisma.sql`"businessId" = ${ctx.businessId!}`,
    Prisma.sql`"branchId" IN (${Prisma.join(branches)})`,
    Prisma.sql`asset::text = ${q.asset}`,
  ];
  if (q.source) c.push(Prisma.sql`source = ${q.source}`);
  if (q.direction) c.push(Prisma.sql`direction::text = ${q.direction}`);
  if (q.metalForm) c.push(Prisma.sql`"metalForm"::text = ${q.metalForm}`);
  if (q.partyId) c.push(Prisma.sql`"partyId" = ${q.partyId}`);
  if (q.stockItemId) c.push(Prisma.sql`"stockItemId" = ${q.stockItemId}`);
  if (q.bankAccountId != null) c.push(q.bankAccountId === 0 ? Prisma.sql`"bankAccountId" IS NULL` : Prisma.sql`"bankAccountId" = ${q.bankAccountId}`);
  // keyword: Ref / ID (source id) or narration — like the other filters it also scopes the opening balance
  if (q.q) c.push(Prisma.sql`("sourceId" = ${q.q} OR narration ILIKE ${`%${q.q}%`})`);
  return c;
}

export async function getLedgerPage(ctx: TenantContext, q: LedgerQ): Promise<LedgerPageDto> {
  const branches = branchFilter(ctx);
  if (branches.length === 0) return { opening: '0', items: [], total: 0, page: q.page, pageSize: q.pageSize };
  const from = dateOnly(ledger.businessDate(q.from ?? new Date()));
  const to = dateOnly(ledger.businessDate(q.to ?? new Date()));
  const unit = Prisma.raw(`"${UNIT[q.asset]}"`); // safe: UNIT values are fixed column names, never user input
  const signed = Prisma.sql`CASE WHEN direction::text = 'IN' THEN ${unit} ELSE -${unit} END`;
  const base = ledgerConds(ctx, q, branches);
  // Compare the DATE column against ::date (not a JS Date → timestamp, which shifts a day under a non-UTC session TZ).
  const whereRange = Prisma.join([...base, Prisma.sql`"txnDate" >= ${from}::date`, Prisma.sql`"txnDate" <= ${to}::date`], ' AND ');

  const [openRows, countRows] = await Promise.all([
    prisma.$queryRaw<{ opening: Prisma.Decimal | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(${signed}), 0)::numeric AS opening FROM "LedgerEntry" WHERE ${Prisma.join([...base, Prisma.sql`"txnDate" < ${from}::date`], ' AND ')}`,
    ),
    prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "LedgerEntry" WHERE ${whereRange}`),
  ]);
  const opening = new Prisma.Decimal(openRows[0]?.opening ?? 0);
  const total = Number(countRows[0]?.count ?? 0);

  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT * FROM (
      SELECT id, "txnDate", "createdAt", "branchId", source, "sourceId", direction, "partyId", "bankAccountId",
        "metalForm", "karatCode", pcs, gross, net, fine, amount, "stockItemId", narration, "reversalOfId", "createdById",
        (SUM(${signed}) OVER (ORDER BY "txnDate", id))::numeric AS running
      FROM "LedgerEntry" WHERE ${whereRange}
    ) t ORDER BY "txnDate", id OFFSET ${(q.page - 1) * q.pageSize} LIMIT ${q.pageSize}`);

  return { opening: opening.toString(), items: await decorateLedger(ctx, rows, opening), total, page: q.page, pageSize: q.pageSize };
}

async function decorateLedger(ctx: TenantContext, rows: RawRow[], opening: Prisma.Decimal): Promise<LedgerRowDto[]> {
  const sdb = scopedDb(ctx);
  const brMap = await scopedNames(sdb.branch, rows.map((r) => r.branchId));
  const partyMap = await scopedNames(sdb.party, uniqIds(rows, 'partyId'));
  const baIds = uniqIds(rows, 'bankAccountId');
  const banks = baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : [];
  const baMap = new Map(banks.map((b) => [b.id, b.bankName]));
  const stockIds = uniqIds(rows, 'stockItemId');
  const stock = stockIds.length ? await sdb.stockItem.findMany({ where: { id: { in: stockIds } }, include: { itemName: true } }) : [];
  const stockMap = new Map(stock.map((s) => [s.id, { id: s.id, label: `${s.itemName.name}${s.tagNo ? ` ${s.tagNo}` : ''}` }]));
  const uMap = await userNames(ctx, uniqIds(rows, 'createdById'));
  const pageIds = rows.map((r) => r.id);
  const reversed = new Set(
    (pageIds.length ? await prisma.ledgerEntry.findMany({ where: { businessId: ctx.businessId!, reversalOfId: { in: pageIds } }, select: { reversalOfId: true } }) : []).map((r) => r.reversalOfId),
  );

  return rows.map((r) => ({
    id: String(r.id),
    txnDate: dateOnly(r.txnDate),
    createdAt: r.createdAt.toISOString(),
    branch: { id: r.branchId, name: brMap.get(r.branchId) ?? '' },
    source: r.source as LedgerSource,
    sourceId: r.sourceId,
    direction: r.direction,
    party: r.partyId != null ? { id: r.partyId, name: partyMap.get(r.partyId) ?? '' } : null,
    bankAccount: r.bankAccountId != null ? { id: r.bankAccountId, name: baMap.get(r.bankAccountId) ?? '' } : null,
    metalForm: r.metalForm,
    karatCode: r.karatCode,
    pcs: r.pcs,
    gross: dec(r.gross),
    net: dec(r.net),
    fine: dec(r.fine),
    amount: dec(r.amount),
    item: r.stockItemId != null ? (stockMap.get(r.stockItemId) ?? null) : null,
    narration: r.narration,
    isReversal: r.reversalOfId != null,
    reversed: reversed.has(r.id),
    balance: opening.plus(r.running).toString(),
    entryBy: r.createdById != null ? (uMap.get(r.createdById) ?? null) : null,
  }));
}

// ───────────── Day-Book ─────────────

export async function getDayBook(ctx: TenantContext, query: { from?: Date; to?: Date; source?: LedgerSource; groupBy?: 'DATE' }): Promise<DayBookDto> {
  const from = ledger.businessDate(query.from ?? new Date());
  const to = ledger.businessDate(query.to ?? new Date());
  const sdb = scopedDb(ctx);
  const scope: any = { branchId: { in: branchFilter(ctx) }, ...(query.source ? { source: query.source } : {}) };
  const sum = { _sum: { amount: true, fine: true, pcs: true } } as const;
  const [range, open, val, bySourceRows] = await Promise.all([
    sdb.ledgerEntry.groupBy({ by: ['asset', 'direction'], where: { ...scope, txnDate: { gte: from, lte: to } }, ...sum }),
    sdb.ledgerEntry.groupBy({ by: ['asset', 'direction'], where: { ...scope, txnDate: { lt: from } }, ...sum }),
    sdb.ledgerEntry.groupBy({ by: ['asset', 'direction'], where: { ...scope, txnDate: { lte: to } }, _sum: { amount: true } }),
    sdb.ledgerEntry.groupBy({ by: ['source', 'asset', 'direction'], where: { ...scope, txnDate: { gte: from, lte: to } }, ...sum }),
  ]);

  const totals: AssetTotalsDto[] = LEDGER_ASSETS.map((asset) => {
    const u = UNIT[asset];
    const unitOf = (g: any) => new Prisma.Decimal(g._sum[u] ?? 0);
    const sumDir = (groups: any[], dir: 'IN' | 'OUT') => groups.filter((g) => g.asset === asset && g.direction === dir).reduce((a, g) => a.plus(unitOf(g)), new Prisma.Decimal(0));
    const opening = sumDir(open, 'IN').minus(sumDir(open, 'OUT'));
    const inSum = sumDir(range, 'IN');
    const outSum = sumDir(range, 'OUT');
    const value = val
      .filter((g) => g.asset === asset)
      .reduce((a, g) => (g.direction === 'IN' ? a.plus(new Prisma.Decimal(g._sum.amount ?? 0)) : a.minus(new Prisma.Decimal(g._sum.amount ?? 0))), new Prisma.Decimal(0));
    return { asset, opening: opening.toString(), in: inSum.toString(), out: outSum.toString(), closing: opening.plus(inSum).minus(outSum).toString(), value: value.toString() };
  });

  const bySourceMap = new Map<string, { source: string; asset: LedgerAsset; in: Prisma.Decimal; out: Prisma.Decimal }>();
  for (const g of bySourceRows) {
    const v = new Prisma.Decimal((g._sum as any)[UNIT[g.asset]] ?? 0);
    const key = `${g.source}|${g.asset}`;
    const e = bySourceMap.get(key) ?? { source: g.source, asset: g.asset, in: new Prisma.Decimal(0), out: new Prisma.Decimal(0) };
    if (g.direction === 'IN') e.in = e.in.plus(v);
    else e.out = e.out.plus(v);
    bySourceMap.set(key, e);
  }
  const bySource = [...bySourceMap.values()].map((e) => ({ source: e.source as LedgerSource, asset: e.asset, in: e.in.toString(), out: e.out.toString() }));

  // TASK-80: single-day requests carry the branch-day status (OPEN when no row yet); ranges / all-branches = null.
  let status: 'OPEN' | 'CLOSED' | null = null;
  if (from.getTime() === to.getTime() && ctx.activeBranchId != null) {
    const row = await scopedDb(ctx).dayBook.findUnique({ where: { businessId_branchId_date: { businessId: ctx.businessId!, branchId: ctx.activeBranchId, date: from } } });
    status = row?.status ?? 'OPEN';
  }

  const days = query.groupBy === 'DATE' ? await dayBookDays(ctx, scope, from, to, open) : undefined;
  return { from: dateOnly(from), to: dateOnly(to), totals, bySource, status, ...(days ? { days } : {}) };
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 62;

/** TASK-97: one opening/in/out/closing row per business day in [from, to] (each day's opening = previous closing), newest first.
 *  Long ranges are trimmed to the last MAX_DAYS days ending at `to` (opening carried in from before that window). */
async function dayBookDays(ctx: TenantContext, scope: any, from: Date, to: Date, openBeforeFrom: any[]): Promise<DayBookDayDto[]> {
  const sdb = scopedDb(ctx);
  const start = new Date(Math.max(from.getTime(), to.getTime() - (MAX_DAYS - 1) * DAY_MS));
  const sum = { _sum: { amount: true, fine: true, pcs: true } } as const;
  const [gap, perDay, closed] = await Promise.all([
    // movements between `from` and the trimmed window start roll into the first day's opening
    start.getTime() > from.getTime()
      ? sdb.ledgerEntry.groupBy({ by: ['asset', 'direction'], where: { ...scope, txnDate: { gte: from, lt: start } }, ...sum })
      : Promise.resolve([] as any[]),
    sdb.ledgerEntry.groupBy({ by: ['txnDate', 'asset', 'direction'], where: { ...scope, txnDate: { gte: start, lte: to } }, ...sum }),
    ctx.activeBranchId != null
      ? sdb.dayBook.findMany({ where: { branchId: ctx.activeBranchId, date: { gte: start, lte: to } }, select: { date: true, status: true } })
      : Promise.resolve([] as { date: Date; status: 'OPEN' | 'CLOSED' }[]),
  ]);
  const statusOf = new Map(closed.map((d) => [dateOnly(d.date), d.status]));
  const val = (g: any, asset: LedgerAsset) => new Prisma.Decimal(g._sum[UNIT[asset]] ?? 0);
  const signed = (groups: any[], asset: LedgerAsset) =>
    groups.filter((g) => g.asset === asset).reduce((a, g) => (g.direction === 'IN' ? a.plus(val(g, asset)) : a.minus(val(g, asset))), new Prisma.Decimal(0));

  const running = new Map(LEDGER_ASSETS.map((a) => [a, signed(openBeforeFrom, a).plus(signed(gap, a))]));
  const out: DayBookDayDto[] = [];
  for (let t = start.getTime(); t <= to.getTime(); t += DAY_MS) {
    const key = dateOnly(new Date(t));
    const rows = perDay.filter((g) => dateOnly(g.txnDate) === key);
    out.push({
      date: key,
      status: ctx.activeBranchId != null ? (statusOf.get(key) ?? 'OPEN') : null,
      totals: LEDGER_ASSETS.map((asset) => {
        const opening = running.get(asset)!;
        const inSum = rows.filter((g) => g.asset === asset && g.direction === 'IN').reduce((a, g) => a.plus(val(g, asset)), new Prisma.Decimal(0));
        const outSum = rows.filter((g) => g.asset === asset && g.direction === 'OUT').reduce((a, g) => a.plus(val(g, asset)), new Prisma.Decimal(0));
        const closing = opening.plus(inSum).minus(outSum);
        running.set(asset, closing);
        return { asset, opening: opening.toString(), in: inSum.toString(), out: outSum.toString(), closing: closing.toString() };
      }),
    });
  }
  return out.reverse();
}

/** TASK-90: Day-Book "All-in-One" — one row per (source, sourceId, txnDate) document with every asset's IN/OUT side by side.
 *  Grouped SQL (3 queries, no per-document round-trips), scoped by businessId + the active branch(es). */
export async function getDayBookAllInOne(ctx: TenantContext, q: { page: number; pageSize: number; from?: Date; to?: Date; source?: LedgerSource }): Promise<Paged<DayBookAllInOneRowDto>> {
  const from = ledger.businessDate(q.from ?? new Date());
  const to = ledger.businessDate(q.to ?? new Date());
  const sdb = scopedDb(ctx);
  const where: any = { branchId: { in: branchFilter(ctx) }, txnDate: { gte: from, lte: to }, ...(q.source ? { source: q.source } : {}) };
  const docs = await sdb.ledgerEntry.groupBy({ by: ['source', 'sourceId', 'txnDate'], where, orderBy: [{ txnDate: 'desc' }, { sourceId: 'desc' }] });
  const total = docs.length;
  const page = docs.slice((q.page - 1) * q.pageSize, (q.page - 1) * q.pageSize + q.pageSize);
  if (page.length === 0) return { items: [], total, page: q.page, pageSize: q.pageSize };

  const scoped = { ...where, sourceId: { in: [...new Set(page.map((d) => d.sourceId))] } };
  const [agg, reps] = await Promise.all([
    sdb.ledgerEntry.groupBy({ by: ['source', 'sourceId', 'txnDate', 'asset', 'direction'], where: scoped, _sum: { amount: true, fine: true, pcs: true } }),
    sdb.ledgerEntry.findMany({ where: scoped, select: { source: true, sourceId: true, txnDate: true, partyId: true, narration: true }, distinct: ['source', 'sourceId', 'txnDate'] }),
  ]);
  const key = (s: string, id: string, d: Date) => `${s}|${id}|${d.toISOString()}`;
  const assetMap = new Map<string, Record<string, { in: Prisma.Decimal; out: Prisma.Decimal }>>();
  for (const g of agg) {
    const k = key(g.source, g.sourceId, g.txnDate);
    let rec = assetMap.get(k);
    if (!rec) {
      rec = Object.fromEntries(LEDGER_ASSETS.map((a) => [a, { in: new Prisma.Decimal(0), out: new Prisma.Decimal(0) }]));
      assetMap.set(k, rec);
    }
    const v = new Prisma.Decimal((g._sum as any)[UNIT[g.asset]] ?? 0);
    if (g.direction === 'IN') rec[g.asset]!.in = rec[g.asset]!.in.plus(v);
    else rec[g.asset]!.out = rec[g.asset]!.out.plus(v);
  }
  const repMap = new Map(reps.map((r) => [key(r.source, r.sourceId, r.txnDate), r]));
  const partyNames = await scopedNames(sdb.party, reps.map((r) => r.partyId).filter((x): x is number => x != null));

  const items: DayBookAllInOneRowDto[] = page.map((d) => {
    const rec = assetMap.get(key(d.source, d.sourceId, d.txnDate));
    const rep = repMap.get(key(d.source, d.sourceId, d.txnDate));
    const assets = Object.fromEntries(
      LEDGER_ASSETS.map((a) => [a, { in: (rec?.[a]?.in ?? new Prisma.Decimal(0)).toString(), out: (rec?.[a]?.out ?? new Prisma.Decimal(0)).toString() }]),
    ) as Record<(typeof LEDGER_ASSETS)[number], { in: string; out: string }>;
    return {
      txnDate: dateOnly(d.txnDate),
      source: d.source as LedgerSource,
      sourceId: d.sourceId,
      party: rep?.partyId != null ? { id: rep.partyId, name: partyNames.get(rep.partyId) ?? '' } : null,
      narration: rep?.narration ?? null,
      assets,
    };
  });
  return { items, total, page: q.page, pageSize: q.pageSize };
}

// ───────────── helpers ─────────────

const uniqIds = (rows: any[], key: string): number[] => [...new Set(rows.map((r) => r[key]).filter((x): x is number => x != null))];

/** id→name from a scoped model delegate (branch/party), empty-safe. */
async function scopedNames(delegate: { findMany: (a: any) => Promise<{ id: number; name: string }[]> }, ids: number[]): Promise<Map<number, string>> {
  const u = [...new Set(ids)];
  if (!u.length) return new Map();
  const rows = await delegate.findMany({ where: { id: { in: u } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Creator display names within the business (raw prisma: an entry's creator may sit outside the active branch). */
async function userNames(ctx: TenantContext, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, businessId: ctx.businessId! }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ───────────── Old Metal Ledger ─────────────

/** Per-source IN/OUT/net of old (KACHA) gold & silver, fine grams; reversal rows net out on their own. */
export async function getOldMetalSummary(ctx: TenantContext, query: { from?: Date; to?: Date }): Promise<OldMetalSummaryRowDto[]> {
  const rows = await scopedDb(ctx).ledgerEntry.groupBy({
    by: ['source', 'asset', 'direction'],
    where: { branchId: { in: branchFilter(ctx) }, asset: { in: ['GOLD', 'SILVER'] }, metalForm: 'KACHA', ...dateWhere(query.from, query.to) },
    _sum: { fine: true },
  });
  const bySource = new Map<string, Record<'goldIn' | 'goldOut' | 'silverIn' | 'silverOut', Prisma.Decimal>>();
  for (const r of rows) {
    const acc = bySource.get(r.source) ?? { goldIn: new Prisma.Decimal(0), goldOut: new Prisma.Decimal(0), silverIn: new Prisma.Decimal(0), silverOut: new Prisma.Decimal(0) };
    const key = `${r.asset === 'GOLD' ? 'gold' : 'silver'}${r.direction === 'IN' ? 'In' : 'Out'}` as keyof typeof acc;
    acc[key] = acc[key].plus(r._sum.fine ?? 0);
    bySource.set(r.source, acc);
  }
  return [...bySource].map(([source, v]) => ({
    source: source as LedgerSource,
    goldIn: v.goldIn.toFixed(3),
    goldOut: v.goldOut.toFixed(3),
    goldNet: v.goldIn.minus(v.goldOut).toFixed(3),
    silverIn: v.silverIn.toFixed(3),
    silverOut: v.silverOut.toFixed(3),
    silverNet: v.silverIn.minus(v.silverOut).toFixed(3),
  }));
}

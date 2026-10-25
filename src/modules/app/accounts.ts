import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import * as ledger from '../../lib/ledger';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { LEDGER_ASSETS } from '../../shared';
import type { AssetTotalsDto, DayBookDto, IncomeExpenseDto, LedgerAsset, LedgerPageDto, LedgerRowDto, LedgerSource, Paged } from '../../shared';

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
    return h;
  });
  return (await decorateIE(ctx, [header]))[0]!;
}

export async function listIncomeExpense(ctx: TenantContext, query: { page: number; pageSize: number; type?: 'INCOME' | 'EXPENSE'; from?: Date; to?: Date }): Promise<Paged<IncomeExpenseDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { isDeleted: false, branchId: { in: branchFilter(ctx) }, ...(query.type ? { type: query.type } : {}), ...dateWhere(query.from, query.to) };
  const [rows, total] = await Promise.all([
    sdb.incomeExpense.findMany({ where, orderBy: [{ txnDate: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.incomeExpense.count({ where }),
  ]);
  return { items: await decorateIE(ctx, rows), total, page: query.page, pageSize: query.pageSize };
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

export async function getDayBook(ctx: TenantContext, query: { from?: Date; to?: Date; source?: LedgerSource }): Promise<DayBookDto> {
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

  return { from: dateOnly(from), to: dateOnly(to), totals, bySource };
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

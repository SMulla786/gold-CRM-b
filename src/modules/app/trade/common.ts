import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { HttpError } from '../../../middleware/error';
import { RATE_UNIT_GRAMS } from '../../../shared';
import type { LedgerSource, Metal, PartyRefDto, TradeHistoryDto, TradePaymentDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { getSettings } from '../service';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
export const money = (d: unknown) => D(d).toFixed(2);
export const wt = (d: unknown) => D(d).toFixed(3);
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

/** Trade documents are branch-owned — a single active branch must be selected (X-Branch-Id for admins). */
export function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for trade (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Grams per rate for a metal in the shop's settings units (gold /10 g, silver /1 kg) — same as sell bills. */
export async function settingsUnit(ctx: TenantContext, metal: Metal): Promise<number> {
  const s = await getSettings(ctx);
  return RATE_UNIT_GRAMS[metal === 'GOLD' ? s['rates.units'].gold : s['rates.units'].silver];
}

export const assertBank = async (ctx: TenantContext, online: number, bankAccountId?: number) => {
  if (online > 0 && !(await scopedDb(ctx).bankAccount.findUnique({ where: { id: bankAccountId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
};

/** Atomic per-(branch, key) document number: seq = next − 1 (same as billing/girvi). */
/**
 * Lock order step 1 (lib/kacha.ts): lock the document row FOR UPDATE before anything else, so a concurrent edit / delete /
 * process of the same document waits instead of reversing the same rows twice. 404 when it no longer exists (or is another business's).
 */
export async function lockDoc(tx: Prisma.TransactionClient, table: 'Exchange' | 'BuySell', id: number, businessId: number): Promise<void> {
  const rows = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE`);
  if (rows.length !== 1) throw new HttpError(404, 'NOT_FOUND', `${table === 'Exchange' ? 'Exchange' : 'Buy-sell'} not found`);
}

export async function nextNo(tx: Prisma.TransactionClient, businessId: number, branchId: number, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${businessId}, ${branchId}, ${key}, 2)
    ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
  return Number(rows[0]!.next) - 1;
}

/** MONEY ledger rows for a cash/online movement (one row each). */
export function moneyRows(source: LedgerSource, branchId: number, txnDate: Date, direction: 'IN' | 'OUT', cash: number, online: number, bankAccountId: number | null, sourceId: string, partyId: number, narration: string): ledger.LedgerEntryInput[] {
  const rows: ledger.LedgerEntryInput[] = [];
  if (cash > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, amount: cash, source, sourceId, partyId, narration });
  if (online > 0) rows.push({ branchId, txnDate, asset: 'MONEY', direction, bankAccountId, amount: online, source, sourceId, partyId, narration });
  return rows;
}

/** A bulk-metal (kacha/bullion) ledger row — net and fine track together for a pool move. */
export function metalRow(source: LedgerSource, branchId: number, txnDate: Date, direction: 'IN' | 'OUT', metal: Metal, form: 'KACHA' | 'BULLION', net: unknown, fine: unknown, sourceId: string, partyId: number | null, narration: string): ledger.LedgerEntryInput {
  return { branchId, txnDate, asset: metal, direction, metalForm: form, net: wt(net), fine: wt(fine), source, sourceId, partyId, narration };
}

export const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });

export async function userName(ctx: TenantContext, id: number | null): Promise<string | null> {
  if (id == null) return null;
  const u = await prisma.user.findFirst({ where: { id, businessId: ctx.businessId! }, select: { name: true } });
  return u?.name ?? null;
}

/** party + branch + bank names for a document DTO, all through scopedDb. */
export async function loadRefs(ctx: TenantContext, row: { partyId: number; branchId: number; bankAccountId: number | null; createdById: number | null }) {
  const sdb = scopedDb(ctx);
  const [party, branch, bank, createdBy] = await Promise.all([
    sdb.party.findUnique({ where: { id: row.partyId } }),
    sdb.branch.findUnique({ where: { id: row.branchId }, select: { name: true } }),
    row.bankAccountId != null ? sdb.bankAccount.findUnique({ where: { id: row.bankAccountId }, select: { bankName: true } }) : Promise.resolve(null),
    userName(ctx, row.createdById),
  ]);
  return {
    party: partyRef(party),
    branch: { id: row.branchId, name: branch?.name ?? '' },
    bankAccount: bank ? { id: row.bankAccountId!, name: bank.bankName } : null,
    createdBy,
  };
}

// ───────────── TASK-97: split payments, edit snapshots, history ─────────────

export type TradeDocType = 'EXCHANGE' | 'BUY_SELL' | 'BHAV';
interface PayRowIn { mode: 'CASH' | 'ONLINE'; amount: number; bankAccountId?: number; reference?: string }
export interface PayInput { cash: number; online: number; bankAccountId?: number; payments?: PayRowIn[] }
/** The money side of a body: cash/online totals + the bank on the doc, and the split rows (null = the single cash/online path). */
export interface PayPlan { cash: number; online: number; bankAccountId: number | null; rows: PayRowIn[] | null }

export async function payPlan(ctx: TenantContext, b: PayInput): Promise<PayPlan> {
  if (!b.payments) {
    await assertBank(ctx, b.online, b.bankAccountId);
    return { cash: b.cash, online: b.online, bankAccountId: b.online > 0 ? b.bankAccountId! : null, rows: null };
  }
  for (const p of b.payments) if (p.mode === 'ONLINE') await assertBank(ctx, p.amount, p.bankAccountId);
  const sum = (m: PayRowIn['mode']) => b.payments!.filter((p) => p.mode === m).reduce((a, p) => a.plus(p.amount), D(0)).toNumber();
  return { cash: sum('CASH'), online: sum('ONLINE'), bankAccountId: b.payments.find((p) => p.mode === 'ONLINE')?.bankAccountId ?? null, rows: b.payments };
}

/** MONEY ledger rows for a plan: exactly moneyRows() on the single path, else one row per split payment (same direction/source/narration). */
export function payRows(plan: PayPlan, source: LedgerSource, branchId: number, txnDate: Date, direction: 'IN' | 'OUT', sourceId: string, partyId: number, narration: string): ledger.LedgerEntryInput[] {
  if (!plan.rows) return moneyRows(source, branchId, txnDate, direction, plan.cash, plan.online, plan.bankAccountId, sourceId, partyId, narration);
  return plan.rows.map((p) => ({ branchId, txnDate, asset: 'MONEY' as const, direction, ...(p.mode === 'ONLINE' ? { bankAccountId: p.bankAccountId! } : {}), amount: p.amount, source, sourceId, partyId, narration }));
}

/** Replace a doc's TradePayment rows with the plan's split rows (none on the single path). */
export async function savePayments(tx: Prisma.TransactionClient, ctx: TenantContext, docType: TradeDocType, docId: number, plan: PayPlan | null): Promise<void> {
  await tx.tradePayment.deleteMany({ where: { businessId: ctx.businessId!, docType, docId } });
  if (plan?.rows) {
    await tx.tradePayment.createMany({ data: plan.rows.map((p) => ({ businessId: ctx.businessId!, docType, docId, mode: p.mode, amount: p.amount, bankAccountId: p.mode === 'ONLINE' ? p.bankAccountId! : null, reference: p.reference ?? null })) });
  }
}

export async function loadPayments(ctx: TenantContext, docType: TradeDocType, docId: number): Promise<TradePaymentDto[]> {
  const rows = await prisma.tradePayment.findMany({ where: { businessId: ctx.businessId!, docType, docId }, orderBy: { id: 'asc' } });
  if (!rows.length) return [];
  const bankIds = [...new Set(rows.map((r) => r.bankAccountId).filter((x): x is number => x != null))];
  const banks = bankIds.length ? await scopedDb(ctx).bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, bankName: true } }) : [];
  const name = new Map(banks.map((b) => [b.id, b.bankName]));
  return rows.map((r) => ({ id: r.id, mode: r.mode as TradePaymentDto['mode'], amount: money(r.amount), bankAccount: r.bankAccountId != null ? { id: r.bankAccountId, name: name.get(r.bankAccountId) ?? '' } : null, reference: r.reference }));
}

/** JSON snapshot of a doc row for ActivityLog.meta (Decimal → string, Date → ISO). */
export const snap = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/** The ActivityLog rows of one trade document (entity as written by its logActivity calls), oldest first. */
export async function docHistory(ctx: TenantContext, entity: string, entityId: number): Promise<TradeHistoryDto[]> {
  const rows = await scopedDb(ctx).activityLog.findMany({ where: { entity, entityId: String(entityId) }, orderBy: { id: 'asc' }, take: 200 });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x != null))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ id: String(r.id), action: r.action, summary: r.summary, user: r.userId != null ? (names.get(r.userId) ?? null) : null, createdAt: r.createdAt.toISOString(), meta: r.meta }));
}

/** txnDate between from/to (inclusive) for list queries. */
export const dateRange = (q: { from?: Date; to?: Date }) => (q.from || q.to ? { txnDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {});

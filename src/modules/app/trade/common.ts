import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { HttpError } from '../../../middleware/error';
import { RATE_UNIT_GRAMS } from '../../../shared';
import type { LedgerSource, Metal, PartyRefDto } from '../../../shared';
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

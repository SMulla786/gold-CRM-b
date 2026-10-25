import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import * as ledger from '../../lib/ledger';
import * as udhar from '../../lib/udhar';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import type { OpeningBatchDto, OpeningEntryInput } from '../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface OpeningBody {
  txnDate?: Date;
  entries: OpeningEntryInput[];
  remark?: string;
}

const money = (d: unknown) => new Prisma.Decimal((d as Prisma.Decimal.Value) ?? 0).toFixed(2);
const wt = (d: unknown) => new Prisma.Decimal((d as Prisma.Decimal.Value) ?? 0).toFixed(3);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });
/** Opening balances belong to one branch — admins must pick one via X-Branch-Id. */
function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for opening balances (set X-Branch-Id)');
  return ctx.activeBranchId;
}
const branchScope = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);

export async function createOpeningBalances(ctx: TenantContext, body: OpeningBody): Promise<OpeningBatchDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  // Resolve every FK through the scoped client up-front (404 if out of tenant).
  for (const e of body.entries) {
    if (e.kind === 'BANK' && !(await sdb.bankAccount.findUnique({ where: { id: e.bankAccountId } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
    if (e.kind === 'PARTY' && !(await sdb.party.findUnique({ where: { id: e.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  }
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const sourceId = randomUUID();
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const ledRows: ledger.LedgerEntryInput[] = [];
    const udRows: udhar.UdharEntryInput[] = [];
    for (const e of body.entries) {
      if (e.kind === 'CASH') ledRows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', amount: e.amount, source: 'OPENING_BALANCE', sourceId, narration: 'Opening cash' });
      else if (e.kind === 'BANK') ledRows.push({ branchId, txnDate, asset: 'MONEY', direction: 'IN', bankAccountId: e.bankAccountId, amount: e.amount, source: 'OPENING_BALANCE', sourceId, narration: 'Opening bank' });
      else if (e.kind === 'METAL') ledRows.push({ branchId, txnDate, asset: e.metal, direction: 'IN', metalForm: e.metalForm, gross: e.fine, net: e.fine, fine: e.fine, source: 'OPENING_BALANCE', sourceId, narration: 'Opening metal' });
      else udRows.push({ branchId, partyId: e.partyId, txnDate, amount: e.amount, gold: e.gold, silver: e.silver, source: 'OPENING_BALANCE', sourceId, narration: 'Opening balance' });
    }
    if (ledRows.length) await ledger.post(tx, lctx, ledRows);
    if (udRows.length) await udhar.post(tx, lctx, udRows);
    await logActivity(tx, ctx, { module: 'OPENING_BALANCE', action: 'CREATED', entity: 'OPENING', entityId: sourceId, summary: `Opening balances (${body.entries.length} ${body.entries.length === 1 ? 'entry' : 'entries'})`, meta: { remark: body.remark ?? null } });
  });
  const [batch] = await buildBatches(ctx, sourceId);
  return batch!;
}

export async function listOpeningBalances(ctx: TenantContext): Promise<OpeningBatchDto[]> {
  return buildBatches(ctx);
}

export async function deleteOpeningBalances(ctx: TenantContext, sourceId: string): Promise<void> {
  const sdb = scopedDb(ctx);
  const where = { source: 'OPENING_BALANCE' as const, sourceId, branchId: { in: branchScope(ctx) } };
  const [led, ud] = await Promise.all([sdb.ledgerEntry.count({ where }), sdb.udharEntry.count({ where })]);
  if (led + ud === 0) throw new HttpError(404, 'NOT_FOUND', 'Opening balance not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    await ledger.reverse(tx, lctx, { source: 'OPENING_BALANCE', sourceId });
    await udhar.reverse(tx, lctx, { source: 'OPENING_BALANCE', sourceId });
    await logActivity(tx, ctx, { module: 'OPENING_BALANCE', action: 'DELETED', entity: 'OPENING', entityId: sourceId, summary: 'Deleted opening balances' });
  });
}

// ───────────── builder ─────────────

/** Build OpeningBatchDto[] from the LedgerEntry + UdharEntry rows grouped by sourceId (one sourceId, or all in scope). */
async function buildBatches(ctx: TenantContext, onlySourceId?: string): Promise<OpeningBatchDto[]> {
  const sdb = scopedDb(ctx);
  const branchWhere = { source: 'OPENING_BALANCE' as const, branchId: { in: branchScope(ctx) }, ...(onlySourceId ? { sourceId: onlySourceId } : {}) };
  const [led, ud] = await Promise.all([
    sdb.ledgerEntry.findMany({ where: branchWhere, orderBy: { id: 'asc' } }),
    sdb.udharEntry.findMany({ where: branchWhere, orderBy: { id: 'asc' } }),
  ]);
  if (led.length === 0 && ud.length === 0) return [];

  // reversed-id sets per table (a reversal row's reversalOfId points at the original it cancels).
  const ledReversed = new Set(led.filter((r) => r.reversalOfId != null).map((r) => Number(r.reversalOfId)));
  const udReversed = new Set(ud.filter((r) => r.reversalOfId != null).map((r) => Number(r.reversalOfId)));
  const ledOrig = led.filter((r) => r.reversalOfId == null);
  const udOrig = ud.filter((r) => r.reversalOfId == null);

  const sourceIds = [...new Set([...ledOrig.map((r) => r.sourceId), ...udOrig.map((r) => r.sourceId)])];
  if (sourceIds.length === 0) return [];

  // name + meta lookups (batched)
  const bankIds = [...new Set(ledOrig.map((r) => r.bankAccountId).filter((x): x is number => x != null))];
  const partyIds = [...new Set(udOrig.map((r) => r.partyId))];
  const branchIds = [...new Set([...ledOrig, ...udOrig].map((r) => r.branchId))];
  const [banks, parties, branches, acts] = await Promise.all([
    bankIds.length ? sdb.bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, bankName: true } }) : [],
    partyIds.length ? sdb.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } }) : [],
    branchIds.length ? sdb.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [],
    prisma.activityLog.findMany({ where: { businessId: ctx.businessId!, module: 'OPENING_BALANCE', entity: 'OPENING', entityId: { in: sourceIds } }, select: { entityId: true, meta: true, userId: true, createdAt: true } }),
  ]);
  const bankMap = new Map(banks.map((b) => [b.id, b.bankName]));
  const partyMap = new Map(parties.map((p) => [p.id, p.name]));
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const userIds = [...new Set(acts.map((a) => a.userId).filter((x): x is number => x != null))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  const actMap = new Map(acts.map((a) => [a.entityId, a]));

  const batches: OpeningBatchDto[] = sourceIds.map((sid) => {
    const myLed = ledOrig.filter((r) => r.sourceId === sid);
    const myUd = udOrig.filter((r) => r.sourceId === sid);
    const first = myLed[0] ?? myUd[0]!;
    const act = actMap.get(sid);
    const reversed = myLed.every((r) => ledReversed.has(Number(r.id))) && myUd.every((r) => udReversed.has(Number(r.id)));
    const bankAgg = new Map<number, Prisma.Decimal>();
    let cash = new Prisma.Decimal(0);
    const metal: OpeningBatchDto['metal'] = [];
    for (const r of myLed) {
      if (r.asset === 'MONEY') {
        if (r.bankAccountId == null) cash = cash.plus(r.amount ?? 0);
        else bankAgg.set(r.bankAccountId, (bankAgg.get(r.bankAccountId) ?? new Prisma.Decimal(0)).plus(r.amount ?? 0));
      } else metal.push({ metal: r.asset as 'GOLD' | 'SILVER', metalForm: (r.metalForm ?? 'BULLION') as 'BULLION' | 'KACHA', fine: wt(r.fine) });
    }
    return {
      sourceId: sid,
      txnDate: first.txnDate.toISOString().slice(0, 10),
      branch: { id: first.branchId, name: branchMap.get(first.branchId) ?? '' },
      remark: ((act?.meta as any)?.remark as string | null) ?? null,
      cash: cash.toFixed(2),
      bank: [...bankAgg.entries()].map(([id, amt]) => ({ bankAccount: { id, name: bankMap.get(id) ?? '' }, amount: amt.toFixed(2) })),
      metal,
      parties: myUd.map((r) => ({ party: { id: r.partyId, name: partyMap.get(r.partyId) ?? '' }, amount: money(r.amount), gold: wt(r.gold), silver: wt(r.silver) })),
      reversed,
      createdBy: act?.userId != null ? (userMap.get(act.userId) ?? null) : null,
      createdAt: (act?.createdAt ?? first.createdAt).toISOString(),
    };
  });
  // newest first by creation time
  return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

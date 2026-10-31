/**
 * TRD-04 one-off data fix. Before TRD-04, a BUY bhav booking's advance was posted like a SELL one (MONEY IN + party
 * credit). This finds BUY bookings (entryType ≠ ONLY_ENTRY) whose active, un-reversed BHAV_BOOKING MONEY rows include
 * an IN row, and re-posts them as GIVEN (MONEY OUT + party debit) through bhav.ts postAdvance itself. No money rule
 * lives in this script.
 *
 * Dry run (the default) only lists them: business, booking id / no., and the advance. --apply fixes each booking in its
 * own transaction:
 *   1. lock the booking row and re-check it inside the lock;
 *   2. ledger.reverse + udhar.reverse (source BHAV_BOOKING, sourceId = booking id);
 *   3. postAdvance with the booking's stored payments.
 * Reversals are dated today by the ledger's own rule, so a closed Day-Book day stays intact. Like an edit, the re-post
 * uses the booking's own date. If that day is closed, ledger.post refuses (DAY_CLOSED), and that booking is rolled back,
 * reported and skipped.
 * Idempotent: once re-posted, a booking has no active IN row, so a second run finds nothing.
 *
 *   npx tsx --env-file=.env scripts/repost-buy-bhav-advances.ts [--business <id>]                    dry run
 *   npx tsx --env-file=.env scripts/repost-buy-bhav-advances.ts --apply --user <id> [--business <id>]
 * --user = the operator's user id, stamped as createdById on the reversal and re-post rows. Back up the database first.
 */
import { pathToFileURL } from 'node:url';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import * as ledger from '../src/lib/ledger';
import * as udhar from '../src/lib/udhar';
import { postAdvance } from '../src/modules/app/trade/bhav';
import { lctxOf } from '../src/modules/app/trade/common';
import type { PayPlan } from '../src/modules/app/trade/common';
import type { TenantContext } from '../src/middleware/context';

const REF = 'BHAV_BOOKING' as const;

export interface Candidate { businessId: number; bookingId: number; bookingNo: number; advance: string }
export interface RepostResult { candidates: Candidate[]; applied: number[]; skipped: number[]; failed: Array<{ bookingId: number; error: string }> }

/** Active (never reversed) BHAV_BOOKING MONEY IN rows, by booking id. */
async function activeInRows(db: Prisma.TransactionClient | typeof prisma, where: Prisma.LedgerEntryWhereInput) {
  const rows = await db.ledgerEntry.findMany({ where: { ...where, source: REF, asset: 'MONEY', direction: 'IN', reversalOfId: null }, select: { id: true, sourceId: true, amount: true } });
  if (!rows.length) return rows;
  const reversed = new Set((await db.ledgerEntry.findMany({ where: { reversalOfId: { in: rows.map((r) => r.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId));
  return rows.filter((r) => !reversed.has(r.id));
}

export async function findCandidates(businessId?: number): Promise<Candidate[]> {
  const rows = await activeInRows(prisma, businessId != null ? { businessId } : {});
  const ids = [...new Set(rows.map((r) => Number(r.sourceId)).filter(Number.isInteger))];
  const books = await prisma.bhavBooking.findMany({ where: { id: { in: ids }, side: 'BUY', entryType: { not: 'ONLY_ENTRY' } }, select: { id: true, businessId: true, bookingNo: true }, orderBy: [{ businessId: 'asc' }, { id: 'asc' }] });
  return books.map((b) => ({
    businessId: b.businessId, bookingId: b.id, bookingNo: b.bookingNo,
    advance: rows.filter((r) => r.sourceId === String(b.id)).reduce((a, r) => a.plus(r.amount ?? 0), new Prisma.Decimal(0)).toFixed(2),
  }));
}

/** Dry run unless `apply`; with apply, `userId` stamps the correction rows. */
export async function repostBuyBhavAdvances(opts: { apply: boolean; userId?: number; businessId?: number }): Promise<RepostResult> {
  const out: RepostResult = { candidates: await findCandidates(opts.businessId), applied: [], skipped: [], failed: [] };
  if (!opts.apply) return out;
  if (opts.userId == null) throw new Error('--apply needs --user <id> (stamped on the correction rows)');
  for (const c of out.candidates) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "BhavBooking" WHERE id = ${c.bookingId} FOR UPDATE`;
        const bk = await tx.bhavBooking.findUniqueOrThrow({ where: { id: c.bookingId } });
        // re-check inside the lock: an edit or another run since the listing may already have fixed it
        if (bk.side !== 'BUY' || bk.entryType === 'ONLY_ENTRY' || !(await activeInRows(tx, { businessId: bk.businessId, sourceId: String(bk.id) })).length) return false;
        const ctx: TenantContext = {
          userId: opts.userId!, level: 'ADMIN', isOwner: false, businessId: bk.businessId, scopeBranchId: bk.branchId, branchIds: [bk.branchId], activeBranchId: bk.branchId,
          readOnly: false, modules: [], limits: null, permissions: {}, impersonatorId: null,
        };
        const ref = { source: REF, sourceId: String(bk.id) };
        await ledger.reverse(tx, lctxOf(ctx), ref);
        await udhar.reverse(tx, lctxOf(ctx), ref);
        // the plan createBhav / updateBhav stored on the booking (split rows in TradePayment, else cash / online / bank)
        const pays = await tx.tradePayment.findMany({ where: { businessId: bk.businessId, docType: 'BHAV', docId: bk.id }, orderBy: { id: 'asc' } });
        const plan: PayPlan = {
          cash: Number(bk.cash), online: Number(bk.online), bankAccountId: bk.bankAccountId,
          rows: pays.length ? pays.map((p) => ({ mode: p.mode as 'CASH' | 'ONLINE', amount: Number(p.amount), bankAccountId: p.bankAccountId ?? undefined, reference: p.reference ?? undefined })) : null,
        };
        await postAdvance(tx, ctx, bk, bk.entryType, plan);
        return true;
      });
      (done ? out.applied : out.skipped).push(c.bookingId);
    } catch (e) {
      out.failed.push({ bookingId: c.bookingId, error: (e as { code?: string }).code ?? (e as Error).message });
    }
  }
  return out;
}

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const n = Number(process.argv[i + 1]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} needs a numeric id`);
    return n;
  };
  const apply = process.argv.includes('--apply');
  const r = await repostBuyBhavAdvances({ apply, userId: arg('--user'), businessId: arg('--business') });
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${r.candidates.length} BUY booking(s) with an advance posted as IN`);
  for (const c of r.candidates) console.log(`  business ${c.businessId}  booking id ${c.bookingId}  no. ${c.bookingNo}  advance ${c.advance}`);
  if (apply) console.log(`applied ${r.applied.length}, skipped ${r.skipped.length} (already fixed), failed ${r.failed.length}${r.failed.map((f) => `\n  booking id ${f.bookingId}: ${f.error}`).join('')}`);
  if (r.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { businessDate } from '../../../lib/ledger';
import { reconcileMetalPools } from '../../../../scripts/reconcile-metal-pools';

/** G7 review 6 + closure (A3) peer-review note: the pool reconciliation reads in one READ ONLY transaction, given 120 s (Prisma's
 *  default interactive-transaction timeout is 5 s, too short for a large ledger on a slow disk), and writes nothing. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('reads every pool READ ONLY with a 120 s timeout; a negative pool lists its rows with the running balance, its totals by source and the first row below zero', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const row = (direction: 'IN' | 'OUT', fine: number, source: string, metalForm: 'KACHA' | 'BULLION' = 'BULLION') =>
    ({ businessId: business.id, branchId: root.id, txnDate: businessDate(), asset: 'GOLD' as const, metalForm, direction, net: fine, fine, source, sourceId: '1' });
  await db.ledgerEntry.create({ data: row('IN', 5, 'OPENING_BALANCE') });
  await db.ledgerEntry.create({ data: row('OUT', 10, 'KARIGAR_ISSUE') });
  await db.ledgerEntry.create({ data: row('IN', 2, 'EXCHANGE_MELT_PROCESS') });
  await db.ledgerEntry.create({ data: row('IN', 7, 'EXCHANGE', 'KACHA') });
  const before = await db.ledgerEntry.count();

  const options: unknown[] = [];
  const spy = { $transaction: (fn: never, opts: unknown) => (options.push(opts), db.$transaction(fn, opts as never)) } as unknown as PrismaClient;
  const r = await reconcileMetalPools(spy);

  expect(options).toEqual([expect.objectContaining({ timeout: 120_000 })]);
  expect(r.readOnly).toBe('on');
  expect(r.pools.map((p) => [p.metal, p.form, p.bal, p.rows])).toEqual([['GOLD', 'BULLION', '-3.000', 3], ['GOLD', 'KACHA', '7.000', 1]]);
  expect(r.negative).toHaveLength(1);
  const neg = r.negative[0]!;
  expect(neg.lines.map((l) => [l.direction, l.fine, l.source, l.running])).toEqual([['IN', '5.000', 'OPENING_BALANCE', '5.000'], ['OUT', '10.000', 'KARIGAR_ISSUE', '-5.000'], ['IN', '2.000', 'EXCHANGE_MELT_PROCESS', '-3.000']]);
  expect(neg.bySource).toEqual({ OPENING_BALANCE: { in: '5.000', out: '0.000', rows: 1 }, KARIGAR_ISSUE: { in: '0.000', out: '10.000', rows: 1 }, EXCHANGE_MELT_PROCESS: { in: '2.000', out: '0.000', rows: 1 } });
  expect(neg.firstNegative?.source).toBe('KARIGAR_ISSUE');
  expect(await db.ledgerEntry.count()).toBe(before);
});

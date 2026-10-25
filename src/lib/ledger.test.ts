import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../test/helpers/db';
import { createBusiness } from '../../test/helpers/factory';
import { prisma } from './prisma';
import { businessDate, post, reverse } from './ledger';

describe('businessDate (Asia/Kolkata)', () => {
  it('maps a post-18:30 UTC instant to the next IST day (the Day-Book bug)', () => {
    // 2026-10-24 20:30 UTC = 2026-10-25 02:00 IST
    expect(businessDate(new Date('2026-10-24T20:30:00Z')).toISOString().slice(0, 10)).toBe('2026-10-25');
    // 2026-10-24 18:00 UTC = 2026-10-24 23:30 IST
    expect(businessDate(new Date('2026-10-24T18:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-24');
  });
});

describe('ledger post/reverse', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('reverses once, dates the reversal today, and a second reverse is a no-op', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
    const ref = { source: 'STOCK_INSERT' as const, sourceId: 'T1' };

    await prisma.$transaction((tx) => post(tx, lctx, [{ branchId: root.id, asset: 'GOLD', direction: 'IN', net: '10.000', fine: '9.167', source: 'STOCK_INSERT', sourceId: 'T1', txnDate: new Date('2026-01-01T00:00:00Z') }]));
    await prisma.$transaction((tx) => reverse(tx, lctx, ref));
    await prisma.$transaction((tx) => reverse(tx, lctx, ref)); // no duplicate

    const rows = await db.ledgerEntry.findMany({ where: { businessId: business.id, source: 'STOCK_INSERT', sourceId: 'T1' } });
    expect(rows).toHaveLength(2); // original + exactly one reversal
    const rev = rows.find((r) => r.reversalOfId != null)!;
    expect(rev.direction).toBe('OUT');
    expect(rev.txnDate.toISOString().slice(0, 10)).toBe(businessDate().toISOString().slice(0, 10)); // dated today, not 2026-01-01
  });
});

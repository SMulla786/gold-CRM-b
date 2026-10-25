import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../test/helpers/db';
import { createBranch, createBusiness } from '../../test/helpers/factory';
import type { TenantContext } from '../middleware/context';
import { scopedDb } from './db';
import { prisma } from './prisma';
import { balances, post, reverse } from './udhar';

const makeParty = (businessId: number, name = 'Cust') =>
  db.party.create({ data: { businessId, type: 'CUSTOMER', name, mobile: '9999999999' } });

const asCtx = (businessId: number, branchIds: number[]) => ({ businessId, branchIds, userId: 1 });
const scoped = (businessId: number, branchIds: number[]) => scopedDb(asCtx(businessId, branchIds) as unknown as TenantContext);

describe('udhar post/reverse/balances', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('post stores a signed movement and balances sums it per party', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const p = await makeParty(business.id);
    const ctx = asCtx(business.id, [root.id]);
    await prisma.$transaction((tx) => post(tx, ctx, [{ branchId: root.id, partyId: p.id, amount: '5000', gold: '10', silver: '0', source: 'UDHAR', sourceId: 'U1' }]));

    const bal = await balances(scoped(business.id, [root.id]), ctx, [p.id]);
    expect(bal.get(p.id)).toEqual({ amount: '5000.00', gold: '10.000', silver: '0.000' });
  });

  it('reverse negates once (idempotent) and returns the balance to zero', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const p = await makeParty(business.id);
    const ctx = asCtx(business.id, [root.id]);
    const ref = { source: 'UDHAR' as const, sourceId: 'U1' };
    await prisma.$transaction((tx) => post(tx, ctx, [{ branchId: root.id, partyId: p.id, amount: '5000', gold: '10', source: 'UDHAR', sourceId: 'U1' }]));
    await prisma.$transaction((tx) => reverse(tx, ctx, ref));
    await prisma.$transaction((tx) => reverse(tx, ctx, ref)); // no-op

    const rows = await db.udharEntry.findMany({ where: { businessId: business.id, source: 'UDHAR', sourceId: 'U1' } });
    expect(rows).toHaveLength(2); // original + exactly one reversal
    const bal = await balances(scoped(business.id, [root.id]), ctx, [p.id]);
    expect(bal.get(p.id)).toEqual({ amount: '0.00', gold: '0.000', silver: '0.000' });
  });

  it('rejects a branch outside the context (404) and an all-zero movement (400)', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const sibling = await createBranch({ businessId: business.id, parentId: root.id, name: 'Other' });
    const p = await makeParty(business.id);
    const ctx = asCtx(business.id, [root.id]);
    await expect(prisma.$transaction((tx) => post(tx, ctx, [{ branchId: sibling.id, partyId: p.id, amount: '1', source: 'UDHAR', sourceId: 'X' }]))).rejects.toMatchObject({ status: 404 });
    await expect(prisma.$transaction((tx) => post(tx, ctx, [{ branchId: root.id, partyId: p.id, amount: '0', gold: '0', silver: '0', source: 'UDHAR', sourceId: 'X' }]))).rejects.toMatchObject({ status: 400 });
  });

  it('balances is scoped to the caller branches and zero for parties with no rows', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const sibling = await createBranch({ businessId: business.id, parentId: root.id, name: 'Sibling' });
    const p = await makeParty(business.id);
    const empty = await makeParty(business.id, 'NoRows');
    // row in the sibling branch — must NOT count toward a root-scoped balance
    await db.udharEntry.create({ data: { businessId: business.id, branchId: sibling.id, partyId: p.id, txnDate: new Date('2026-01-01'), amount: '999', source: 'UDHAR', sourceId: 'S1' } });
    await prisma.$transaction((tx) => post(tx, asCtx(business.id, [root.id]), [{ branchId: root.id, partyId: p.id, amount: '100', source: 'UDHAR', sourceId: 'U1' }]));

    const bal = await balances(scoped(business.id, [root.id]), asCtx(business.id, [root.id]), [p.id, empty.id]);
    expect(bal.get(p.id)).toEqual({ amount: '100.00', gold: '0.000', silver: '0.000' }); // sibling's 999 excluded
    expect(bal.get(empty.id)).toEqual({ amount: '0.00', gold: '0.000', silver: '0.000' });
  });
});

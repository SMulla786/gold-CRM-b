import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../test/helpers/db';
import { createBusiness } from '../../test/helpers/factory';
import { prisma } from './prisma';
import { post } from './ledger';
import { assertKachaAvailable, kachaBalance } from './kacha';

describe('kacha pool guard', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  async function seed10() {
    const { business, root } = await createBusiness({ name: 'K' });
    const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
    await prisma.$transaction((tx) =>
      post(tx, lctx, [{ branchId: root.id, asset: 'GOLD', direction: 'IN', metalForm: 'KACHA', net: '10.000', fine: '10.000', source: 'EXCHANGE', sourceId: 'seed' }]),
    );
    return { root, lctx };
  }

  it('allows a draw up to the balance and 409s just over it', async () => {
    const { root } = await seed10();
    expect((await kachaBalance(db, root.id, 'GOLD')).kacha).toBe('10');
    await expect(prisma.$transaction((tx) => assertKachaAvailable(tx, root.id, 'GOLD', '10'))).resolves.toBeUndefined();
    await expect(prisma.$transaction((tx) => assertKachaAvailable(tx, root.id, 'GOLD', '10.001'))).rejects.toMatchObject({ status: 409 });
  });

  it('serializes two concurrent 6g draws against 10g — exactly one succeeds', async () => {
    const { root, lctx } = await seed10();
    const draw = () =>
      prisma.$transaction(async (tx) => {
        await assertKachaAvailable(tx, root.id, 'GOLD', '6');
        await post(tx, lctx, [{ branchId: root.id, asset: 'GOLD', direction: 'OUT', metalForm: 'KACHA', net: '6.000', fine: '6.000', source: 'EXCHANGE_MELT_PROCESS', sourceId: 'draw' }]);
      });

    const results = await Promise.allSettled([draw(), draw()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409 });
    expect((await kachaBalance(db, root.id, 'GOLD')).kacha).toBe('4'); // 10 − one 6g draw
  });
});

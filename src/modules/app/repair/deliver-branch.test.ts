import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import * as repair from './service';
import type { TenantContext } from '../../../middleware/context';

/** Owner decision 2026-11-09: a repair delivery posts to the acting user's branch (X-Branch-Id → activeBranch(ctx)), not to the
 *  ticket's own branch — the delivery cash and the party's balance land there. With 'all' (no one branch picked) the delivery is
 *  refused (400) and nothing is written. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(active: 'root' | 'all') {
  const { business, root } = await createBusiness({ name: 'A' });
  const shop = await createBranch({ businessId: business.id, parentId: root.id, name: 'Station Road' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id, shop.id], activeBranchId: active === 'root' ? root.id : null,
    readOnly: false, modules: ['repair'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const t = await db.repairTicket.create({ data: { businessId: business.id, branchId: shop.id, ticketNo: 1, partyId: party.id, metal: 'GOLD', category: 'Ring', description: 'Resize', gross: 5, expectedDate: new Date(), status: 'READY', labourCharge: 1500 } });
  const deliver = () => repair.deliverRepair(ctx, t.id, { addedFine: 0, addedRate: 0, cash: 1000, online: 0 });
  const rows = async () => [
    (await db.ledgerEntry.findMany({ where: { source: 'REPAIR', sourceId: String(t.id) } })).map((r) => [r.branchId, Number(r.amount)]),
    (await db.udharEntry.findMany({ where: { source: 'REPAIR', sourceId: String(t.id) } })).map((r) => [r.branchId, Number(r.amount)]),
  ];
  const status = async () => (await db.repairTicket.findUniqueOrThrow({ where: { id: t.id } })).status;
  return { root, deliver, rows, status };
}

describe("owner decision 2026-11-09: posts to the acting user's branch", () => {
  it('delivered with X-Branch-Id of another branch (the root): its cash and the party balance land in the root', async () => {
    const s = await setup('root');
    await s.deliver();
    expect(await s.rows()).toEqual([[[s.root.id, 1000]], [[s.root.id, 500]]]);
    expect(await s.status()).toBe('DELIVERED');
  });

  it("delivered with X-Branch-Id 'all': 400 (pick one branch), nothing written, the ticket stays READY", async () => {
    const s = await setup('all');
    await expect(s.deliver()).rejects.toMatchObject({ status: 400 });
    expect(await s.rows()).toEqual([[], []]);
    expect(await s.status()).toBe('READY');
  });
});

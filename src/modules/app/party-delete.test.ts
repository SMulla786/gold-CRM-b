import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import type { TenantContext } from '../../middleware/context';
import { deleteParty } from './service';
import { partyBalance } from './udhar';

// Phase 8: DELETE /app/parties/:id (deleteParty) had no test. Pins TODAY's behaviour: a soft delete (isActive = false)
// that never touches the party's financial rows. Whether a party with a balance may be deleted is an open owner question.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['udhari', 'billing'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bill = await db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: 'B1', seq: 1, partyId: party.id, billDate: new Date(), sub: 1000, taxable: 1000, total: 1000, final: 1000, paid: 0 } });
  await db.udharEntry.create({ data: { businessId: business.id, branchId: root.id, partyId: party.id, txnDate: new Date(), amount: 1000, gold: 0, silver: 0, source: 'SELL_BILL', sourceId: String(bill.id) } });
  await db.ledgerEntry.create({ data: { businessId: business.id, branchId: root.id, partyId: party.id, txnDate: new Date(), asset: 'MONEY', direction: 'IN', amount: 0, source: 'SELL_BILL', sourceId: String(bill.id) } });
  return { ctx, party };
}
const rowsOf = async (partyId: number) => ({
  bills: await db.bill.findMany({ where: { partyId }, select: { id: true, status: true, final: true, paid: true } }),
  udhar: await db.udharEntry.findMany({ where: { partyId }, select: { id: true, amount: true } }),
  ledger: await db.ledgerEntry.findMany({ where: { partyId }, select: { id: true, amount: true } }),
});

describe('deleteParty (soft delete)', () => {
  it('sets isActive = false only; bills, udhar and ledger rows and the balance are untouched', async () => {
    const s = await setup();
    const [before, balBefore] = [await rowsOf(s.party.id), await partyBalance(s.ctx, s.party.id)];
    expect(balBefore.amount).toBe('1000.00');

    await deleteParty(s.ctx, s.party.id);
    expect((await db.party.findUniqueOrThrow({ where: { id: s.party.id } })).isActive).toBe(false);
    expect(await rowsOf(s.party.id)).toEqual(before);
    expect(await partyBalance(s.ctx, s.party.id)).toEqual(balBefore);
  });

  it("another business's party → 404 and it stays active", async () => {
    const a = await setup('A');
    const b = await setup('B');
    await expect(deleteParty(a.ctx, b.party.id)).rejects.toMatchObject({ status: 404 });
    expect((await db.party.findUniqueOrThrow({ where: { id: b.party.id } })).isActive).toBe(true);
  });

  it('deleting twice is harmless (still inactive, nothing else changes)', async () => {
    const s = await setup();
    const before = await rowsOf(s.party.id);
    await deleteParty(s.ctx, s.party.id);
    await deleteParty(s.ctx, s.party.id);
    expect([(await db.party.findUniqueOrThrow({ where: { id: s.party.id } })).isActive, await rowsOf(s.party.id)]).toEqual([false, before]);
  });
});

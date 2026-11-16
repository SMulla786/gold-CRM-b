import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviTransferBody } from '../../../shared';
import * as girvi from './service';
import * as transfer from './transfer';
import type { TenantContext } from '../../../middleware/context';

/** G7 closure (A3): a girvi with only its grant can be deleted — but not once an item went to a lender (girvi transfer): the
 *  transfer keeps pointing at the item (FK RESTRICT), so the delete is a clear 409 with nothing changed, not a database error (500). */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('deleting a girvi whose item was transferred to a lender → 409, the loan, its grant rows and the transfer stay', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const lender = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Lender', mobile: '9000000002', countryCode: '+91' } });
  const g = await girvi.createGirvi(ctx, girviBody.parse({
    partyId: party.id, items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }],
    principal: 10000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 6, cash: 10000, online: 0,
  }));
  await transfer.createTransfer(ctx, girviTransferBody.parse({ lenderPartyId: lender.id, itemIds: [g.items[0]!.id], principal: 8000, cash: 8000, online: 0, ratePercent: 1.5, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3 }));
  const state = async () => [await db.girviBatch.count(), await db.girviItem.count(), await db.girviTransferItem.count(), await db.ledgerEntry.count({ where: { reversalOfId: { not: null } } })];
  const before = await state();
  await expect(girvi.deleteGirvi(ctx, g.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/lender/) });
  expect(await state()).toEqual(before);
});

import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviReleaseBody } from '../../../shared';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 owner rule (girvi compound interest): an interest-only part payment never reduces the principal interest compounds on; an explicit
 *  principal repayment reduces it by exactly its recorded allocation. Each payment's audit row carries the split and the interest working. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('CI: ₹200 interest-only keeps compounding on ₹10,000; ₹4,000 principal repaid → ₹6,000; the audit rows carry the split and the working', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const item = (name: string) => ({ category: 'Gold', name, gross: 12, net: 10, purity: 91.67, rate: 6000 });
  // ₹10,000 at 2 % / month compounded monthly, full months: due after n months = 10,000 × (1.02ⁿ − 1)
  const g = await girvi.createGirvi(ctx, girviBody.parse({
    partyId: party.id, issueDate: new Date('2026-01-01'), items: [item('Chain'), item('Ring')],
    principal: 10000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'CI', ciPeriod: 'MONTHLY', method: 'FULL_MONTH', tenureMonths: 12, cash: 10000, online: 0,
  }));
  const on = (d: string) => girvi.getGirvi(ctx, g.id, new Date(d));
  expect((await on('2026-03-01')).interestDue).toBe('404.00'); // 10,000 × (1.02² − 1)

  await girvi.payInterest(ctx, g.id, { txnDate: new Date('2026-03-01'), interest: 200, discount: 0, cash: 200, online: 0 });
  const afterPart = await on('2026-04-01');
  // 10,000 × (1.02³ − 1) = 612.08, less the ₹200 paid = 412.08 (on ₹9,800 it would be 399.84)
  expect([afterPart.principal, afterPart.interestDue]).toEqual(['10000.00', '412.08']);

  const chain = afterPart.items.find((i) => i.name === 'Chain')!;
  await girvi.releaseGirvi(ctx, g.id, girviReleaseBody.parse({ txnDate: new Date('2026-04-01'), itemIds: [chain.id], principalPaid: 4000, interestPaid: 412.08, cash: 4412.08 }));
  const afterRepay = await on('2026-05-01');
  expect([afterRepay.principal, afterRepay.interestDue]).toEqual(['6000.00', '120.00']); // one month on ₹6,000
  expect(afterRepay.txns.find((t) => t.type === 'RELEASE')).toMatchObject({ principal: '4000.00', interest: '412.08', discount: '0.00' });

  const [interestRow, releaseRow] = await db.activityLog.findMany({ where: { businessId: business.id, module: 'GIRVI', action: { not: 'CREATED' } }, orderBy: { id: 'asc' } });
  expect(interestRow).toMatchObject({
    summary: expect.stringMatching(/interest ₹200\.00 .*principal stays ₹10000\.00/),
    meta: {
      allocation: { principal: '0.00', interest: '200.00', discount: '0.00' }, principalBefore: '10000.00', principalAfter: '10000.00',
      interest: { from: '2026-01-01', to: '2026-03-01', principal: '10000.00', rate: '2', type: 'CI', ciPeriod: 'MONTHLY', method: 'FULL_MONTH', accrued: '404.00', paidBefore: '0.00', due: '404.00' },
    },
  });
  expect(releaseRow).toMatchObject({
    summary: expect.stringMatching(/principal ₹4000\.00 \+ interest ₹412\.08.*principal ₹10000\.00 → ₹6000\.00/),
    meta: {
      allocation: { principal: '4000.00', interest: '412.08', discount: '0.00' }, principalBefore: '10000.00', principalAfter: '6000.00',
      interest: { from: '2026-01-01', to: '2026-04-01', principal: '10000.00', accrued: '612.08', paidBefore: '200.00', due: '412.08' },
    },
  });
});

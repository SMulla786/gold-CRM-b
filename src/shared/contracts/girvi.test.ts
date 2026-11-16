import { describe, expect, it } from 'vitest';
import { girviInterestBody, girviReleaseBody, girviTopupBody } from './girvi';

/** G7 D-c: the money that moves (cash + online) must equal the amount the girvi books — else the ledger and the loan disagree. */

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

describe('girvi bodies: cash + online = amount', () => {
  it('interest: equals the interest received (a discount is waived, not received)', () => {
    expect([
      ok(girviInterestBody, { interest: 500, cash: 300, online: 0 }),
      ok(girviInterestBody, { interest: 500, discount: 100, cash: 600, online: 0 }),
      ok(girviInterestBody, { interest: 500, cash: 300, online: 200, bankAccountId: 1 }),
      ok(girviInterestBody, { interest: 500, discount: 100, cash: 500 }),
    ]).toEqual([false, false, true, true]);
  });

  it('top-up: equals the extra principal paid out', () => {
    expect([ok(girviTopupBody, { principal: 1000, cash: 500, online: 0 }), ok(girviTopupBody, { principal: 1000, cash: 1000 })]).toEqual([false, true]);
  });

  it('release: equals principal + interest received; nothing paid → nothing moves', () => {
    expect([
      ok(girviReleaseBody, { itemIds: [1], principalPaid: 1000, interestPaid: 50, cash: 1000 }),
      ok(girviReleaseBody, { itemIds: [1], principalPaid: 1000, interestPaid: 50, discount: 10, cash: 1060 }),
      ok(girviReleaseBody, { itemIds: [1], principalPaid: 1000, interestPaid: 50, discount: 10, cash: 1050 }),
      ok(girviReleaseBody, { itemIds: [1] }),
      ok(girviReleaseBody, { itemIds: [1], cash: 100 }),
    ]).toEqual([false, false, true, true, false]);
  });
});

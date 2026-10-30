import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createUser } from '../helpers/factory';
import { loadAccess } from '../../src/lib/access';
import * as platform from '../../src/modules/platform/service';
import { createBusinessBody, planBody } from '../../src/shared/contracts/platform';

// Phase 5: ads only while the business's CURRENT term (startsAt ≤ now < endsAt, ACTIVE) is ad-supported — a snapshot taken
// from the plan when the term was made. Never the plan's price, never the latest-ending or a queued term.

const DAY = 864e5;
const at = (days: number) => new Date(Date.now() + days * DAY);
beforeEach(truncateAll);

async function biz(name = 'A') {
  const { business, root } = await createBusiness({ name });
  return { business, root };
}
const term = (businessId: number, planId: number, from: number, to: number, adSupported: boolean, status: 'ACTIVE' | 'CANCELLED' = 'ACTIVE') =>
  db.subscription.create({ data: { businessId, planId, startsAt: at(from), endsAt: at(to), status, maxBranches: 5, maxUsers: 5, modules: [], adSupported } });
const eligible = async (businessId: number, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') => (await loadAccess(businessId, status)).subscription?.adEligible;

describe('ad eligibility = the current term\'s own snapshot', () => {
  it('current ad-supported term → ads; paid term → none; a free-priced trial that is not ad-supported → none', async () => {
    const plan = await createPlan();
    const [a, b, c] = [await biz('A'), await biz('B'), await biz('C')];
    await term(a.business.id, plan.id, -1, 30, true);
    await term(b.business.id, plan.id, -1, 30, false);
    const trial = await db.plan.create({ data: { name: `trial-${Date.now()}`, durationDays: 14, price: '0', maxBranches: 1, maxUsers: 1, modules: [] } });
    await term(c.business.id, trial.id, -1, 14, false);
    expect([await eligible(a.business.id), await eligible(b.business.id), await eligible(c.business.id)]).toEqual([true, false, false]);
  });

  it('expired or suspended → no ads (and read-only)', async () => {
    const plan = await createPlan();
    const a = await biz('A');
    const b = await biz('B');
    await term(a.business.id, plan.id, -40, -1, true);
    await term(b.business.id, plan.id, -1, 30, true);
    expect(await loadAccess(a.business.id, 'ACTIVE')).toMatchObject({ readOnly: true, subscription: { adEligible: false } });
    expect(await eligible(b.business.id, 'SUSPENDED')).toBe(false);
  });

  it('queued terms never decide: paid now + ad-supported queued → no ads; ad-supported now + paid queued → ads', async () => {
    const plan = await createPlan();
    const a = await biz('A');
    const b = await biz('B');
    await term(a.business.id, plan.id, -10, 5, false);
    await term(a.business.id, plan.id, 5, 40, true); // ends later — the old "latest-ending" pick would have shown ads
    await term(b.business.id, plan.id, -10, 5, true);
    await term(b.business.id, plan.id, 5, 40, false);
    expect([await eligible(a.business.id), await eligible(b.business.id)]).toEqual([false, true]);
  });

  it('a cancelled current term does not count', async () => {
    const plan = await createPlan();
    const a = await biz();
    await term(a.business.id, plan.id, -1, 30, true, 'CANCELLED');
    await term(a.business.id, plan.id, -1, 20, false);
    expect(await eligible(a.business.id)).toBe(false);
  });
});

describe('snapshot on term creation (platform)', () => {
  it('plan create/update carries adSupported; terms copy it at creation; repricing or unflagging the plan never changes an existing term', async () => {
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const free = await platform.createPlan(planBody.parse({ name: 'Free with ads', durationDays: 30, price: 0, maxBranches: 1, maxUsers: 2, modules: ['billing'], adSupported: true }));
    const paid = await platform.createPlan(planBody.parse({ name: 'Pro', durationDays: 30, price: 999, maxBranches: 5, maxUsers: 10, modules: ['billing'] }));
    expect([free.adSupported, paid.adSupported]).toEqual([true, false]);

    // provisioning (create wizard) and assign both snapshot the plan
    const made = await platform.createBusiness(sa.user.id, createBusinessBody.parse({ name: 'Shop One', ownerName: 'Owner', mobile: '9876543210', planId: free.id, owner: { name: 'Owner', username: `own${Date.now()}`, password: 'Passw0rd!' } }));
    expect(await eligible(made.id)).toBe(true);
    const b = await biz('B');
    await platform.assignSubscription(sa.user.id, b.business.id, { planId: free.id, startsAt: at(-1) });
    expect(await eligible(b.business.id)).toBe(true);

    expect((await platform.updatePlan(free.id, { price: 499, adSupported: false })).adSupported).toBe(false);
    expect([await eligible(made.id), await eligible(b.business.id)]).toEqual([true, true]); // existing terms keep their snapshot
    const c = await biz('C');
    await platform.assignSubscription(sa.user.id, c.business.id, { planId: free.id, startsAt: at(-1) });
    expect(await eligible(c.business.id)).toBe(false); // a new term takes the new flag
    expect((await platform.updatePlan(paid.id, { price: 0 })).adSupported).toBe(false); // price 0 alone never means ads
  });
});

describe('/auth/me', () => {
  it('returns subscription.adEligible for the owner', async () => {
    const plan = await createPlan();
    const a = await biz('A');
    const b = await biz('B');
    await term(a.business.id, plan.id, -1, 30, true);
    await term(b.business.id, plan.id, -1, 30, false);
    for (const [x, want] of [[a, true], [b, false]] as const) {
      const owner = await createUser({ businessId: x.business.id, branchId: x.root.id, level: 'ADMIN', isOwner: true });
      const { token } = await loginAs(owner.username);
      const me = await api.get('/api/auth/me').set('Authorization', bearer(token!));
      expect(me.body.subscription).toMatchObject({ adEligible: want });
    }
  });

  it('never ad-eligible while a Super Admin impersonates an ad-supported business', async () => {
    const plan = await createPlan();
    const a = await biz('A');
    await term(a.business.id, plan.id, -1, 30, true);
    await createUser({ businessId: a.business.id, branchId: a.root.id, level: 'ADMIN', isOwner: true });
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const saAuth = bearer((await loginAs(sa.username)).token!);
    const imp = await api.post(`/api/platform/businesses/${a.business.id}/impersonate`).set('Authorization', saAuth).send({ reason: 'support ticket' });
    expect(imp.status).toBe(201);
    const me = await api.get('/api/auth/me').set('Authorization', bearer(imp.body.accessToken));
    expect([me.body.impersonatedBy?.id, me.body.subscription?.adEligible]).toEqual([sa.user.id, false]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../../test/helpers/app';
import { truncateAll } from '../../../test/helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../../../test/helpers/factory';

// BUG-5: GET /app/rates/current must be readable by any tenant user (cashier/billing-only), not gated on settings.misc.
const MODULES = ['billing', 'inventory', 'daybook']; // a cashier plan WITHOUT 'settings'

beforeEach(truncateAll);

describe('BUG-5 current rates are open to any tenant user', () => {
  it('a billing-only branch user (no settings.misc, no settings module) can GET /rates/current but not the gated rate-limits', async () => {
    const plan = await createPlan({ modules: MODULES });
    const { business, root } = await createBusiness({ name: 'A' });
    await createSubscription({ businessId: business.id, planId: plan.id, modules: MODULES });
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER' });
    const { token } = await loginAs(u.username);

    const rates = await api.get('/api/app/rates/current').set('Authorization', bearer(token!));
    expect(rates.status).toBe(200);
    expect(rates.body).toHaveProperty('gold');
    expect(rates.body).toHaveProperty('silver');

    // the editing/limits side stays behind settings.misc
    const limits = await api.get('/api/app/rate-limits').set('Authorization', bearer(token!));
    expect(limits.status).toBe(403);
  });
});

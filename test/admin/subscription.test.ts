import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// Tenant subscription page (/admin/subscription): available plans, plan columns on history, UPI UTR rule.

async function setup() {
  const plan = await createPlan();
  const { business, root } = await createBusiness({ name: 'A' });
  const sub = await createSubscription({ businessId: business.id, planId: plan.id });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const { token } = await loginAs(owner.username);
  return { plan, sub, business, auth: bearer(token!) };
}

beforeEach(truncateAll);

describe('GET /admin/subscription', () => {
  it('lists only ACTIVE plans as availablePlans and marks the current plan id', async () => {
    const { plan, auth } = await setup();
    const other = await createPlan();
    const retired = await createPlan();
    await db.plan.update({ where: { id: retired.id }, data: { isActive: false } });

    const res = await api.get('/api/admin/subscription').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe(plan.id);
    const ids = (res.body.availablePlans as { id: number }[]).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([plan.id, other.id]));
    expect(ids).not.toContain(retired.id);
    const row = (res.body.availablePlans as Record<string, unknown>[]).find((p) => p.id === plan.id)!;
    expect(row).toMatchObject({ name: plan.name, durationDays: 365, price: '0', maxBranches: 10, maxUsers: 50 });
  });

  it('history rows carry the linked subscription plan name and duration', async () => {
    const { plan, auth } = await setup();
    const sent = await api.post('/api/admin/subscription/payments').set('Authorization', auth).send({ amount: 500, method: 'UPI', utr: '123456789012' });
    expect(sent.status).toBe(201);
    const res = await api.get('/api/admin/subscription').set('Authorization', auth);
    expect(res.body.payments[0]).toMatchObject({ id: sent.body.id, planName: plan.name, planDurationDays: 365, utr: '123456789012', status: 'PENDING' });
  });
});

describe('POST /admin/subscription/payments', () => {
  it('UPI needs a 12-digit UTR (11 digits or letters -> 400); other methods keep free-form refs', async () => {
    const { auth } = await setup();
    const post = (body: Record<string, unknown>) => api.post('/api/admin/subscription/payments').set('Authorization', auth).send(body);
    expect((await post({ amount: 500, method: 'UPI', utr: '12345678901' })).status).toBe(400);
    expect((await post({ amount: 500, method: 'UPI', utr: '12345678901A' })).status).toBe(400);
    expect((await post({ amount: 500, method: 'UPI', utr: '123456789012' })).status).toBe(201);
    expect((await post({ amount: 500, method: 'BANK', utr: 'NEFT-REF-1' })).status).toBe(201);
  });

  it('a planId that is not an active plan -> 404', async () => {
    const { auth } = await setup();
    const retired = await createPlan();
    await db.plan.update({ where: { id: retired.id }, data: { isActive: false } });
    const post = (planId: number) => api.post('/api/admin/subscription/payments').set('Authorization', auth).send({ amount: 500, method: 'CASH', planId });
    expect((await post(retired.id)).status).toBe(404);
    expect((await post(999999)).status).toBe(404);
  });

  it('stores an active requested planId; history shows the requested plan over the subscription plan', async () => {
    const { plan, auth } = await setup();
    const other = await db.plan.create({ data: { name: `gold-${Date.now()}`, durationDays: 30, price: '999', maxBranches: 2, maxUsers: 5, modules: [] } });
    const sent = await api.post('/api/admin/subscription/payments').set('Authorization', auth).send({ amount: 999, method: 'UPI', utr: '123456789012', planId: other.id });
    expect(sent.status).toBe(201);
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id: sent.body.id } })).planId).toBe(other.id);

    const plain = await api.post('/api/admin/subscription/payments').set('Authorization', auth).send({ amount: 10, method: 'CASH' });
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id: plain.body.id } })).planId).toBeNull();

    const rows = (await api.get('/api/admin/subscription').set('Authorization', auth)).body.payments as Record<string, unknown>[];
    expect(rows.find((r) => r.id === sent.body.id)).toMatchObject({ planName: other.name, planDurationDays: 30 });
    expect(rows.find((r) => r.id === plain.body.id)).toMatchObject({ planName: plan.name, planDurationDays: 365 });
  });
});

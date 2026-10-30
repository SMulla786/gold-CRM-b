import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';
import { platformPaymentProofPath } from '../../src/modules/app/uploads';
import * as platform from '../../src/modules/platform/service';
import { createBusinessBody } from '../../src/shared/contracts/platform';

// ADM-08 (TASK-95/98) payment proof upload → Super Admin review, read-only owners can still pay, renewal (G2b: renew once on confirm);
// PLAT-03 business alternate mobile from the create wizard.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const proofIds: number[] = [];

async function setup(name = 'A', endsAt?: Date) {
  const plan = await createPlan();
  const { business, root } = await createBusiness({ name });
  const sub = await createSubscription({ businessId: business.id, planId: plan.id, ...(endsAt ? { endsAt } : {}) });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const admin = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN' });
  return { plan, sub, business, root, auth: bearer((await loginAs(owner.username)).token!), adminAuth: bearer((await loginAs(admin.username)).token!) };
}
type S = Awaited<ReturnType<typeof setup>>;
const pay = async (s: S) => {
  const r = await api.post('/api/admin/subscription/payments').set('Authorization', s.auth).send({ amount: 999, method: 'UPI', utr: '123456789012' });
  expect(r.status).toBe(201);
  proofIds.push(r.body.id);
  return r.body.id as number;
};
const upload = (auth: string, id: number, buf: Buffer) => api.post(`/api/admin/subscription/payments/${id}/proof`).set('Authorization', auth).attach('file', buf, 'proof.bin');
const view = (auth: string, id: number) => api.get(`/api/admin/subscription/payments/${id}/proof`).set('Authorization', auth);
const superAuth = async () => bearer((await loginAs((await createUser({ level: 'SUPER_ADMIN' })).username)).token!);
const review = (auth: string, id: number, status: string) => api.patch(`/api/platform/payments/${id}`).set('Authorization', auth).send({ status });

beforeEach(truncateAll);
afterEach(async () => {
  for (const id of proofIds.splice(0)) await platformPaymentProofPath(id).then((p) => rm(p, { force: true }), () => undefined);
});

describe('payment proof (ADM-08)', () => {
  it('owner uploads a screenshot while PENDING (re-upload replaces it); non-images → 400; staff admins and other businesses cannot see or upload', async () => {
    const s = await setup('A');
    const b = await setup('B');
    const id = await pay(s);
    expect((await upload(s.auth, id, PNG)).body).toEqual({ url: `/api/admin/subscription/payments/${id}/proof` });
    const first = (await db.subscriptionPayment.findUniqueOrThrow({ where: { id } })).screenshotUrl;
    const got = await view(s.auth, id);
    expect([got.status, got.headers['content-type']]).toEqual([200, 'image/png']);
    expect((await upload(s.auth, id, JPG)).status).toBe(201);
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id } })).screenshotUrl).not.toBe(first);
    expect((await view(s.auth, id)).headers['content-type']).toBe('image/jpeg');

    expect((await upload(s.auth, id, Buffer.from('not an image at all'))).status).toBe(400);
    expect((await upload(s.adminAuth, id, PNG)).status).toBe(403);
    expect((await view(s.adminAuth, id)).status).toBe(403);
    expect((await upload(b.auth, id, PNG)).status).toBe(404);
    expect((await view(b.auth, id)).status).toBe(404);
  });

  it('Super Admin confirms once (second decision → 409, unknown → 404); after review the proof is frozen but still viewable by both sides', async () => {
    const s = await setup();
    const id = await pay(s);
    await upload(s.auth, id, PNG);
    const sa = await superAuth();
    expect((await api.get(`/api/platform/payments/${id}/proof`).set('Authorization', sa)).status).toBe(200);
    expect((await review(s.auth, id, 'CONFIRMED')).status).toBe(403); // tenants can't reach /platform

    const ok = await review(sa, id, 'CONFIRMED');
    expect([ok.status, ok.body.status]).toEqual([200, 'CONFIRMED']);
    expect((await review(sa, id, 'REJECTED')).status).toBe(409);
    expect((await review(sa, 999999, 'CONFIRMED')).status).toBe(404);
    expect((await upload(s.auth, id, JPG)).status).toBe(404); // only a PENDING payment takes a proof
    expect((await view(s.auth, id)).headers['content-type']).toBe('image/png');
    const hist = await api.get('/api/admin/subscription').set('Authorization', s.auth);
    expect(hist.body.payments[0]).toMatchObject({ id, status: 'CONFIRMED' });
  });

  it('read-only (expired) owner can still record a payment and upload its proof; other writes stay blocked', async () => {
    const s = await setup('A', new Date(Date.now() - 864e5));
    expect((await api.post('/api/admin/counters').set('Authorization', s.auth).send({ branchId: s.root.id, name: 'C1' })).body.error?.code).toBe('READ_ONLY');
    const id = await pay(s);
    expect((await upload(s.auth, id, PNG)).status).toBe(201);
    expect((await api.get('/api/admin/subscription').set('Authorization', s.auth)).body.readOnly).toBe(true);
  });
});

describe('renewal (ADM-08)', () => {
  const payFor = async (s: S, planId: number) => {
    const r = await api.post('/api/admin/subscription/payments').set('Authorization', s.auth).send({ amount: 999, method: 'UPI', utr: '123456789012', planId });
    expect(r.status).toBe(201);
    return r.body.id as number;
  };
  const terms = (s: S) => db.subscription.findMany({ where: { businessId: s.business.id }, orderBy: { endsAt: 'asc' } });

  it('G2b: confirming a payment for a plan renews exactly once: new term from the current end, payment linked; a second decision changes nothing', async () => {
    const s = await setup();
    const id = await payFor(s, s.plan.id);
    const sa = await superAuth();
    expect((await review(sa, id, 'CONFIRMED')).status).toBe(200);
    const [old, renewed, ...more] = await terms(s);
    expect(more).toEqual([]);
    expect(old!.id).toBe(s.sub.id);
    expect(renewed!.startsAt.getTime()).toBe(s.sub.endsAt.getTime());
    expect(renewed!.endsAt.getTime()).toBe(s.sub.endsAt.getTime() + 365 * 864e5);
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id } })).subscriptionId).toBe(renewed!.id);
    expect((await api.get('/api/admin/subscription').set('Authorization', s.auth)).body.endsAt).toBe(renewed!.endsAt.toISOString());

    expect((await review(sa, id, 'CONFIRMED')).status).toBe(409);
    expect((await review(sa, id, 'REJECTED')).status).toBe(409);
    expect(await terms(s)).toHaveLength(2);
  });

  it('G2b: concurrent confirmations of one payment renew once; two payments confirmed together stack their terms', async () => {
    const s = await setup();
    const sa = await superAuth();
    const one = await payFor(s, s.plan.id);
    const codes = (await Promise.all([review(sa, one, 'CONFIRMED'), review(sa, one, 'CONFIRMED')])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(await terms(s)).toHaveLength(2);

    const [a, b] = [await payFor(s, s.plan.id), await payFor(s, s.plan.id)];
    expect((await Promise.all([review(sa, a, 'CONFIRMED'), review(sa, b, 'CONFIRMED')])).map((r) => r.status)).toEqual([200, 200]);
    const all = await terms(s);
    expect(all).toHaveLength(4);
    for (let i = 1; i < all.length; i++) expect(all[i]!.startsAt.getTime()).toBe(all[i - 1]!.endsAt.getTime()); // back to back, no overlap
  });

  it('G2b: rejected → no renewal; an expired business renews from now; a payment without a plan (legacy / platform-recorded) renews nothing', async () => {
    const sa = await superAuth();
    const s = await setup('A', new Date(Date.now() - 864e5));
    await review(sa, await payFor(s, s.plan.id), 'REJECTED');
    expect(await terms(s)).toHaveLength(1);
    const before = Date.now();
    await review(sa, await payFor(s, s.plan.id), 'CONFIRMED');
    const renewed = (await terms(s)).at(-1)!;
    expect(renewed.startsAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await api.get('/api/admin/subscription').set('Authorization', s.auth)).body.readOnly).toBe(false);

    const t = await setup('B');
    await review(sa, await pay(t), 'CONFIRMED');
    expect(await terms(t)).toHaveLength(1);
  });

  it('a payment without a plan does not extend the term; a new subscription while active starts at the current end', async () => {
    const s = await setup();
    const id = await pay(s);
    const sa = await superAuth();
    await review(sa, id, 'CONFIRMED');
    expect((await db.subscription.findMany({ where: { businessId: s.business.id } })).map((x) => x.endsAt)).toEqual([s.sub.endsAt]);

    const next = await api.post(`/api/platform/businesses/${s.business.id}/subscriptions`).set('Authorization', sa).send({ planId: s.plan.id, durationDays: 30 });
    expect(next.status).toBe(201);
    expect(next.body.startsAt).toBe(s.sub.endsAt.toISOString());
    expect(new Date(next.body.endsAt).getTime()).toBe(s.sub.endsAt.getTime() + 30 * 864e5);
    expect((await api.get('/api/admin/subscription').set('Authorization', s.auth)).body.endsAt).toBe(next.body.endsAt);
  });
});

describe('business alternate mobile (PLAT-03)', () => {
  it('create wizard stores it and the detail shows it; optional; a bad number → 400 at the contract', async () => {
    const plan = await createPlan();
    const sa = await createUser({ level: 'SUPER_ADMIN' });
    const body = (o: Record<string, unknown>) => ({ name: 'Shree Jewellers', ownerName: 'Owner', mobile: '9876543210', planId: plan.id, owner: { name: 'Owner', username: `own${Date.now()}`, password: 'Passw0rd!' }, ...o });
    const made = await platform.createBusiness(sa.user.id, createBusinessBody.parse(body({ alternateMobile: '9123456780' })));
    expect((await platform.businessDetail(made.id)).alternateMobile).toBe('9123456780');
    const plain = await platform.createBusiness(sa.user.id, createBusinessBody.parse(body({ owner: { name: 'Owner', username: `own2${Date.now()}`, password: 'Passw0rd!' } })));
    expect(plain.alternateMobile).toBeNull();
    for (const bad of ['91234', '91234567801', 'abcdefghij']) expect(createBusinessBody.safeParse(body({ alternateMobile: bad })).success).toBe(false);

    const auth = await superAuth();
    const res = await api.post('/api/platform/businesses').set('Authorization', auth).send(body({ alternateMobile: '12', owner: { name: 'Owner', username: `own3${Date.now()}`, password: 'Passw0rd!' } }));
    expect(res.status).toBe(400);
  });
});

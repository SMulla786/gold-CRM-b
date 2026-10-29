import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../helpers/app';
import { db, truncateAll } from '../helpers/db';
import { TEST_MPIN, createBusiness, createPlan, createSubscription, createUser } from '../helpers/factory';

// BILL-11: Remove logo / signature / watermark (InvoiceSettings "Remove") — settings.misc edit + MPIN, clears only that field.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UPLOADS = path.join(process.cwd(), 'uploads');

async function biz() {
  const modules = ['billing'];
  const plan = await createPlan({ modules });
  const { business, root } = await createBusiness({ name: 'A' });
  await createSubscription({ businessId: business.id, planId: plan.id, modules });
  return { business, root };
}

async function adminToken(businessId: number, branchId: number) {
  const u = await createUser({ businessId, branchId, level: 'ADMIN', mpin: TEST_MPIN });
  return (await loginAs(u.username)).token!;
}

const upload = (token: string, kind: string) =>
  api.post(`/api/app/settings/invoice/${kind}`).set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN).attach('file', PNG, 'x.png');
const media = async (businessId: number) =>
  (await db.setting.findUnique({ where: { businessId_branchId_key: { businessId, branchId: 0, key: 'invoice.media' } } }))?.value as Record<string, string | null>;

beforeEach(truncateAll);

describe('BILL-11 invoice media remove', () => {
  it('needs the MPIN; then clears only that field, deletes its file and the image 404s', async () => {
    const { business, root } = await biz();
    const token = await adminToken(business.id, root.id);
    expect((await upload(token, 'logo')).status).toBe(201);
    expect((await upload(token, 'signature')).status).toBe(201);
    const before = await media(business.id);
    const logoFile = path.join(UPLOADS, before.logoUrl!);
    expect(existsSync(logoFile)).toBe(true);

    const noMpin = await api.delete('/api/app/settings/invoice/logo').set('Authorization', bearer(token));
    expect(noMpin.status).toBe(403);
    expect(noMpin.body.error.code).toBe('MPIN_REQUIRED');
    expect(existsSync(logoFile)).toBe(true);

    expect((await api.delete('/api/app/settings/invoice/logo').set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN)).status).toBe(204);
    const after = await media(business.id);
    expect(after.logoUrl).toBeNull();
    expect(after.signatureUrl).toBe(before.signatureUrl);
    expect(existsSync(logoFile)).toBe(false);
    expect((await api.get('/api/app/files/invoice/logo').set('Authorization', bearer(token))).status).toBe(404);
    expect((await api.get('/api/app/files/invoice/signature').set('Authorization', bearer(token))).status).toBe(200);

    // tidy the remaining test file
    expect((await api.delete('/api/app/settings/invoice/signature').set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN)).status).toBe(204);
    expect(existsSync(path.join(UPLOADS, before.signatureUrl!))).toBe(false);
  });

  it('nothing uploaded → still 204', async () => {
    const { business, root } = await biz();
    const token = await adminToken(business.id, root.id);
    expect((await api.delete('/api/app/settings/invoice/watermark').set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN)).status).toBe(204);
    expect((await media(business.id)).watermarkUrl).toBeNull();
  });

  it('a user without settings.misc edit is forbidden', async () => {
    const { business, root } = await biz();
    const u = await createUser({ businessId: business.id, branchId: root.id, level: 'BRANCH_USER', mpin: TEST_MPIN });
    const token = (await loginAs(u.username)).token!;
    const res = await api.delete('/api/app/settings/invoice/logo').set('Authorization', bearer(token)).set('X-MPIN', TEST_MPIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

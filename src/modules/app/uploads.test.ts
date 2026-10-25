import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { invoiceImagePath, savePartyImage, saveInvoiceImage, saveStockImage } from './uploads';
import { putSetting } from './service';
import type { TenantContext } from '../../middleware/context';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const ctxFor = (businessId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: null,
  branchIds: [],
  activeBranchId: null,
  readOnly: false,
  modules: [],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

const exists = (rel: string) => access(path.join(UPLOAD_ROOT, rel)).then(() => true).catch(() => false);

let cleanupBusinessIds: number[] = [];
beforeEach(truncateAll);
afterAll(async () => {
  for (const id of cleanupBusinessIds) await rm(path.join(UPLOAD_ROOT, String(id)), { recursive: true, force: true }).catch(() => {});
  await db.$disconnect();
});

describe('savePartyImage', () => {
  it('rejects a non-image buffer -> 400', async () => {
    const { business } = await createBusiness({ name: 'A' });
    cleanupBusinessIds.push(business.id);
    const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'C', mobile: '9000000001' } });
    await expect(savePartyImage(ctxFor(business.id), party.id, 'photoUrl', Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
  });

  it('saves by magic bytes, stores the relative path, and deletes the old file on replace', async () => {
    const { business } = await createBusiness({ name: 'A' });
    cleanupBusinessIds.push(business.id);
    const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'C', mobile: '9000000002' } });
    const ctx = ctxFor(business.id);

    const rel1 = await savePartyImage(ctx, party.id, 'photoUrl', PNG);
    expect(rel1).toMatch(new RegExp(`^${business.id}/parties/[0-9a-f-]+\\.png$`));
    expect(await exists(rel1)).toBe(true);
    expect((await db.party.findUniqueOrThrow({ where: { id: party.id } })).photoUrl).toBe(rel1);

    const rel2 = await savePartyImage(ctx, party.id, 'photoUrl', JPG);
    expect(rel2.endsWith('.jpg')).toBe(true);
    expect(await exists(rel2)).toBe(true);
    expect(await exists(rel1)).toBe(false); // old file removed on replace
  });
});

describe('saveStockImage', () => {
  const stockItem = async (businessId: number, branchId: number) => {
    const group = await db.itemGroup.create({ data: { businessId, stockClass: 'GOLD', name: 'G' } });
    const itemName = await db.itemName.create({ data: { businessId, groupId: group.id, name: 'I' } });
    return db.stockItem.create({ data: { businessId, branchId, stockClass: 'GOLD', groupId: group.id, itemNameId: itemName.id, method: 'TAG', source: 'STOCK_INSERT' } });
  };

  it('saves a per-row image under <businessId>/stock and stores the path', async () => {
    const { business, root } = await createBusiness({ name: 'S' });
    cleanupBusinessIds.push(business.id);
    const item = await stockItem(business.id, root.id);
    const ctx = { ...ctxFor(business.id), branchIds: [root.id], activeBranchId: root.id };

    const rel = await saveStockImage(ctx, item.id, PNG);
    expect(rel).toMatch(new RegExp(`^${business.id}/stock/[0-9a-f-]+\\.png$`));
    expect(await exists(rel)).toBe(true);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: item.id } })).photoUrl).toBe(rel);
  });

  it('404s for a stock item outside the caller branch subtree', async () => {
    const { business, root } = await createBusiness({ name: 'S2' });
    cleanupBusinessIds.push(business.id);
    const item = await stockItem(business.id, root.id);
    const outside = { ...ctxFor(business.id), branchIds: [root.id + 1000], activeBranchId: root.id + 1000 };
    await expect(saveStockImage(outside, item.id, PNG)).rejects.toMatchObject({ status: 404 });
  });
});

describe('saveInvoiceImage (TASK-84)', () => {
  const media = (businessId: number) => db.setting.findUniqueOrThrow({ where: { businessId_branchId_key: { businessId, branchId: 0, key: 'invoice.media' } } }).then((s) => s.value as Record<string, unknown>);

  it('saves under <businessId>/invoice, stores the path in invoice.media, merges fields, and deletes a replaced file', async () => {
    const { business } = await createBusiness({ name: 'Inv' });
    cleanupBusinessIds.push(business.id);
    const ctx = ctxFor(business.id);

    const logo = await saveInvoiceImage(ctx, 'logoUrl', PNG);
    expect(logo).toMatch(new RegExp(`^${business.id}/invoice/[0-9a-f-]+\\.png$`));
    expect(await exists(logo)).toBe(true);
    expect((await media(business.id)).logoUrl).toBe(logo);

    const sig = await saveInvoiceImage(ctx, 'signatureUrl', JPG);
    const m2 = await media(business.id);
    expect(m2.logoUrl).toBe(logo); // untouched by the second upload
    expect(m2.signatureUrl).toBe(sig);

    const logo2 = await saveInvoiceImage(ctx, 'logoUrl', JPG);
    expect(await exists(logo2)).toBe(true);
    expect(await exists(logo)).toBe(false); // old logo file removed on replace
  });

  it('saving invoice.content does not touch invoice.media', async () => {
    const { business } = await createBusiness({ name: 'Inv2' });
    cleanupBusinessIds.push(business.id);
    const ctx = ctxFor(business.id);
    const logo = await saveInvoiceImage(ctx, 'logoUrl', PNG);
    await putSetting(ctx, 'invoice.content', 0, { format: 'CLASSIC', terms: 'hi', columns: [], watermarkOpacity: 50 });
    expect((await media(business.id)).logoUrl).toBe(logo);
  });

  it('invoiceImagePath 404s when nothing is uploaded', async () => {
    const { business } = await createBusiness({ name: 'Inv3' });
    cleanupBusinessIds.push(business.id);
    await expect(invoiceImagePath(ctxFor(business.id), 'watermarkUrl')).rejects.toMatchObject({ status: 404 });
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as extras from './inventory-extras';
import type { TenantContext } from '../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchId,
  branchIds: [branchId],
  activeBranchId: branchId,
  readOnly: false,
  modules: ['inventory', 'settings', 'dashboard'],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  return { business, root, ctx: ctxFor(business.id, root.id) };
}

describe('set stock', () => {
  it('posts one SET_STOCK row for the difference and logs old/new balance', async () => {
    const s = await setup();
    const first = await extras.setStock(s.ctx, { card: 'FINE_GOLD', newBalance: 10, remarks: 'opening count' });
    expect(Number(first.oldBalance)).toBe(0);
    expect(Number(first.newBalance)).toBe(10);
    let led = await db.ledgerEntry.findMany({ where: { businessId: s.business.id, source: 'SET_STOCK' }, orderBy: { id: 'asc' } });
    expect(led).toHaveLength(1);
    expect(led[0]!.asset).toBe('GOLD');
    expect(led[0]!.metalForm).toBe('USUAL');
    expect(led[0]!.direction).toBe('IN');
    expect(Number(led[0]!.fine)).toBeCloseTo(10, 3);
    expect(led[0]!.sourceId).toBe(String(first.id));

    // Lowering posts an OUT for the difference only.
    const second = await extras.setStock(s.ctx, { card: 'FINE_GOLD', newBalance: 7.5 });
    expect(Number(second.oldBalance)).toBeCloseTo(10, 3);
    led = await db.ledgerEntry.findMany({ where: { businessId: s.business.id, source: 'SET_STOCK' }, orderBy: { id: 'asc' } });
    expect(led).toHaveLength(2);
    expect(led[1]!.direction).toBe('OUT');
    expect(Number(led[1]!.fine)).toBeCloseTo(2.5, 3);

    const summary = await extras.allStockSummary(s.ctx);
    expect(Number(summary.fineGold)).toBeCloseTo(7.5, 3);
    const logs = await extras.listSetStockLogs(s.ctx, { page: 1, pageSize: 20 });
    expect(logs.total).toBe(2);
    expect(await db.activityLog.count({ where: { businessId: s.business.id, module: 'SET_STOCK' } })).toBe(2);
  });

  it('shop cash posts MONEY with no bank account; kaccha posts KACHA', async () => {
    const s = await setup();
    await extras.setStock(s.ctx, { card: 'SHOP_CASH', newBalance: 5000 });
    await extras.setStock(s.ctx, { card: 'KACCHA_SILVER', newBalance: 100 });
    const led = await db.ledgerEntry.findMany({ where: { businessId: s.business.id, source: 'SET_STOCK' }, orderBy: { id: 'asc' } });
    expect(led.map((r) => [r.asset, r.metalForm, r.bankAccountId, r.direction])).toEqual([['MONEY', null, null, 'IN'], ['SILVER', 'KACHA', null, 'IN']]);
    expect(Number(led[0]!.amount)).toBe(5000);
    const summary = await extras.allStockSummary(s.ctx);
    expect(Number(summary.shopCash)).toBe(5000);
    expect(Number(summary.kacchaSilver)).toBeCloseTo(100, 3);
  });

  it('same balance writes a log but no ledger row', async () => {
    const s = await setup();
    await extras.setStock(s.ctx, { card: 'FINE_SILVER', newBalance: 0 });
    expect(await db.ledgerEntry.count({ where: { businessId: s.business.id, source: 'SET_STOCK' } })).toBe(0);
    expect(await db.setStockLog.count({ where: { businessId: s.business.id } })).toBe(1);
  });
});

describe('tag templates', () => {
  const tpl = (name: string, appliesTo: ('GOLD' | 'SILVER' | 'STONE')[]) => ({
    name, widthMm: 80, heightMm: 12, shape: 'RECT' as const, direction: 'HORIZONTAL' as const, appliesTo,
    elements: [{ id: 'e1', type: 'barcode' as const, x: 1, y: 1, w: 30, h: 8, field: 'tagNo' as const }],
  });

  it('activate keeps one active template per stock class', async () => {
    const s = await setup();
    const a = await extras.createTagTemplate(s.ctx, tpl('Gold+Silver', ['GOLD', 'SILVER']));
    const b = await extras.createTagTemplate(s.ctx, tpl('Gold only', ['GOLD']));
    const c = await extras.createTagTemplate(s.ctx, tpl('Stone', ['STONE']));
    await extras.activateTagTemplate(s.ctx, a.id);
    await extras.activateTagTemplate(s.ctx, c.id);
    await extras.activateTagTemplate(s.ctx, b.id);
    const byId = new Map((await extras.listTagTemplates(s.ctx)).map((t) => [t.id, t.isActive]));
    expect(byId.get(a.id)).toBe(false); // shared GOLD with b
    expect(byId.get(b.id)).toBe(true);
    expect(byId.get(c.id)).toBe(true); // STONE untouched
  });

  it('is scoped to the business', async () => {
    const s = await setup();
    const other = await createBusiness({ name: 'B' });
    const t = await extras.createTagTemplate(s.ctx, tpl('Mine', ['GOLD']));
    await expect(extras.getTagTemplate(ctxFor(other.business.id, other.root.id), t.id)).rejects.toThrow('Tag template not found');
  });
});

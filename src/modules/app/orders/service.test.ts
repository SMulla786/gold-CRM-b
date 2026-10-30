import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as inv from '../inventory';
import * as orders from './service';
import * as samples from '../samples/service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  await db.metalRate.create({ data: { businessId: business.id, metal: 'GOLD', branchId: root.id, rateUnit: 'GRAM_10', karatCode: '22K', sellRate: 60000, buyRate: 59000, effectiveAt: new Date() } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const karigar = await db.party.create({ data: { businessId: business.id, type: 'KARIGAR', name: 'Karigar', mobile: '9000000002', countryCode: '+91' } });
  return { business, root, ctx, itemName: itemName!, customer, karigar };
}

const sumUdhar = async (partyId: number) => {
  const rows = await db.udharEntry.findMany({ where: { partyId }, select: { amount: true, gold: true, silver: true } });
  return { amount: rows.reduce((a, r) => a + Number(r.amount), 0), gold: rows.reduce((a, r) => a + Number(r.gold), 0), silver: rows.reduce((a, r) => a + Number(r.silver), 0) };
};
const orderItem = (over: Record<string, unknown> = {}) => ({ itemNameId: 0, metal: 'GOLD', karatCode: '22K', gross: 10, making: 500, makingUnit: 'PER_GRAM', pcs: 1, ...over });

async function makeOrder(ctx: TenantContext, itemNameId: number, customerId: number, payments: any[] = []) {
  return orders.createOrder(ctx, { partyId: customerId, rateType: 'ON_DELIVERY', isUrgent: false, items: [orderItem({ itemNameId })], payments } as any);
}

describe('orders', () => {
  it('create with cash + metal advance → ORDER_ADVANCE ledger + party credited (negative udhar)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id, [
      { mode: 'CASH', amount: 10000 },
      { mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 5, less: 0, tunch: 100, rate: 60000 },
    ]);
    expect(order.status).toBe('PENDING');
    expect(Number(order.estTotal)).toBeGreaterThan(0);
    expect(order.payments).toHaveLength(2);

    const led = await db.ledgerEntry.findMany({ where: { source: 'ORDER_ADVANCE' } });
    expect(led.filter((r) => r.asset === 'MONEY' && r.direction === 'IN')).toHaveLength(1);
    const gold = led.find((r) => r.asset === 'GOLD')!;
    expect(gold.direction).toBe('IN');
    expect(Number(gold.fine)).toBe(5);

    const bal = await sumUdhar(s.customer.id); // shop owes the customer until billed
    expect(bal.amount).toBe(-10000);
    expect(bal.gold).toBe(-5);
  });

  it('karigar issue → KARIGAR_ISSUE OUT + karigar owes the shop; order IN_PROCESS, items ASSIGNED', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 2000, online: 0 } as any);
    expect(issue.status).toBe('OPEN');

    const led = await db.ledgerEntry.findMany({ where: { source: 'KARIGAR_ISSUE' } });
    expect(led.find((r) => r.asset === 'GOLD')!.direction).toBe('OUT');
    expect(led.find((r) => r.asset === 'MONEY')!.direction).toBe('OUT');
    const bal = await sumUdhar(s.karigar.id);
    expect(bal.gold).toBe(10); // karigar owes the issued gold + cash
    expect(bal.amount).toBe(2000);
    expect((await orders.getOrder(s.ctx, order.id)).status).toBe('IN_PROCESS');
    expect((await orders.getOrder(s.ctx, order.id)).items[0]!.status).toBe('ASSIGNED');
  });

  it('receive with ghat → finished piece RESERVED + ORDER_RECEIVE IN, order READY, karigar udhar nets', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 0, online: 0 } as any);
    const received = await orders.receiveKarigar(s.ctx, issue.id, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 9.5, returnedLess: 0, touch: 100, ghatAllowance: 0.3, labour: 800 }] } as any);
    expect(received.status).toBe('RECEIVED');

    const piece = await db.stockItem.findFirst({ where: { source: 'ORDER_RECEIVE', sourceId: String(order.id) } });
    expect(piece?.status).toBe('RESERVED');
    expect(Number(piece!.fine)).toBe(9.5);
    const recv = await db.ledgerEntry.findMany({ where: { source: 'ORDER_RECEIVE', asset: 'GOLD' } });
    expect(recv[0]!.direction).toBe('IN');

    expect((await orders.getOrder(s.ctx, order.id)).status).toBe('READY');
    const bal = await sumUdhar(s.karigar.id); // issued 10 − (returned 9.5 + ghat 0.3) = 0.2 still owed
    expect(bal.gold).toBeCloseTo(0.2, 3);
    expect(bal.amount).toBe(-800); // shop owes the karigar the labour
  });

  it('cancel is blocked while a karigar issue is open (409); a plain PENDING order cancels', async () => {
    const s = await setup();
    const o1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [o1.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any);
    await expect(orders.cancelOrder(s.ctx, o1.id)).rejects.toMatchObject({ status: 409 });

    const o2 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.cancelOrder(s.ctx, o2.id);
    expect((await orders.getOrder(s.ctx, o2.id)).status).toBe('CANCELLED');
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const other = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'B cust', mobile: '9111111111', countryCode: '+91' } });
    await expect(makeOrder(s.ctx, s.itemName.id, bParty.id)).rejects.toMatchObject({ status: 404 });
  });

  it('two concurrent receives of the same item → one wins, one 409, exactly one finished piece (BUG-10)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 10, silverFine: 0, cash: 0, online: 0 } as any);
    const recv = () => orders.receiveKarigar(s.ctx, issue.id, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 9.5, returnedLess: 0, touch: 100, ghatAllowance: 0.3, labour: 800 }] } as any);
    const results = await Promise.allSettled([recv(), recv()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).status === 409)).toHaveLength(1);
    expect(await db.stockItem.count({ where: { source: 'ORDER_RECEIVE', sourceId: String(order.id) } })).toBe(1); // no duplicate piece
  });

  it('two concurrent issues of the same item → one wins, one 409 (BUG-10)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = () => orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any);
    const results = await Promise.allSettled([issue(), issue()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).status === 409)).toHaveLength(1);
  });

  it('a non-karigar party cannot be issued to (400)', async () => {
    const s = await setup();
    const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await expect(orders.createKarigarIssue(s.ctx, { karigarId: s.customer.id, orderItemIds: [order.items[0]!.id], goldFine: 1, silverFine: 0, cash: 0, online: 0 } as any)).rejects.toMatchObject({ status: 400 });
  });

  it('TASK-97: estTotal unchanged without the new fields; adds labour + misc, wastageGm adds fine (NET basis)', async () => {
    const s = await setup();
    const plain = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    // 10 g net × 60000/10 g = 60000 metal + 10 g × 500 making = 65000 (default NET basis)
    expect(plain.estTotal).toBe('65000.00');
    expect(plain.miscCharges).toBe('0.00');
    expect(plain.items[0]!.labour).toBe('0.00');
    expect(plain.items[0]!.wastageGm).toBe('0.000');
    const extra = await orders.createOrder(s.ctx, { partyId: s.customer.id, rateType: 'ON_DELIVERY', isUrgent: false, miscCharges: 150, items: [orderItem({ itemNameId: s.itemName.id, labour: 300, wastageGm: 0.5 })], payments: [] } as any);
    expect(extra.estTotal).toBe('65450.00');
    expect(extra.items[0]!.estTotal).toBe('65300.00');
    expect(Number(extra.items[0]!.fine)).toBeCloseTo(Number(plain.items[0]!.fine) + 0.5, 3);
    expect(extra.miscCharges).toBe('150.00');
  });

  it('TASK-97: wastageGm reaches the money only on FINE basis; rate override drives estTotal + FIXED lock', async () => {
    const s = await setup();
    expect(orders.orderLineExtras({ fine: '9.167', total: '1000.00' }, { wastageGm: 0, labour: 0, rate: 60000, unitGrams: 10, basis: 'FINE' })).toEqual({ fine: '9.167', total: '1000.00' });
    expect(orders.orderLineExtras({ fine: '9.167', total: '1000.00' }, { wastageGm: 0.5, labour: 100, rate: 60000, unitGrams: 10, basis: 'FINE' })).toEqual({ fine: '9.667', total: '4100.00' });
    const o = await orders.createOrder(s.ctx, { partyId: s.customer.id, rateType: 'FIXED', isUrgent: false, goldRate: 70000, items: [orderItem({ itemNameId: s.itemName.id })], payments: [] } as any);
    expect(o.estTotal).toBe('75000.00'); // 10 g × 7000 + 5000 making
    expect(o.goldRate).toBe('70000.00');
  });

  it('TASK-97: karigar wastage stored; list statuses filter', async () => {
    const s = await setup();
    const o1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const o2 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const issue = await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [o1.items[0]!.id], goldFine: 0, silverFine: 0, cash: 0, online: 0, wastagePercent: 2.5, wastageGm: 0.2 } as any);
    expect(issue.wastagePercent).toBe('2.500');
    expect(issue.wastageGm).toBe('0.200');
    await orders.cancelOrder(s.ctx, o2.id);
    const page = { page: 1, pageSize: 20 };
    expect((await orders.listOrders(s.ctx, { ...page, statuses: ['IN_PROCESS', 'CANCELLED'] })).total).toBe(2);
    expect((await orders.listOrders(s.ctx, { ...page, statuses: ['PENDING'] })).total).toBe(0);
    expect((await orders.listOrders(s.ctx, { ...page, status: 'CANCELLED', statuses: ['IN_PROCESS', 'CANCELLED'] })).items.map((o) => o.id)).toEqual([o2.id]);
  });
  it('task99: list q searches order no / party name / party mobile / item name', async () => {
    const s = await setup();
    const other = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Ramesh Patil', mobile: '9876543210', countryCode: '+91' } });
    const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Chains'], gstRate: 3 });
    const chain = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Rope Chain', method: 'TAG', tagPrefix: 'RC', tagDigits: 4 });
    const o1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const o2 = await makeOrder(s.ctx, chain!.id, other.id);
    const page = { page: 1, pageSize: 20 };
    const ids = async (q: string) => (await orders.listOrders(s.ctx, { ...page, q })).items.map((o) => o.id).sort();
    expect(await ids(String(o2.orderNo))).toEqual([o2.id]);
    expect(await ids(`#${o1.orderNo}`)).toEqual([o1.id]);
    expect(await ids('ramesh')).toEqual([o2.id]);
    expect(await ids('98765')).toEqual([o2.id]);
    expect(await ids('rope')).toEqual([o2.id]);
    expect(await ids('gold ring')).toEqual([o1.id]);
    expect(await ids('zzz-nothing')).toEqual([]);
    expect((await orders.listOrders(s.ctx, { ...page, q: '  ' })).total).toBe(2); // blank q = no filter
  });
  it('TASK-98: next-no peeks without consuming (two calls equal, then create gets it); next-tag peek likewise', async () => {
    const s = await setup();
    expect((await orders.peekNextOrderNo(s.ctx)).nextNo).toBe(1); // no DocSequence row yet
    const o1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    expect(o1.orderNo).toBe(1);
    const p1 = await orders.peekNextOrderNo(s.ctx);
    const p2 = await orders.peekNextOrderNo(s.ctx);
    expect(p1).toEqual(p2);
    expect(p1.nextNo).toBe(2);
    expect((await makeOrder(s.ctx, s.itemName.id, s.customer.id)).orderNo).toBe(p1.nextNo);

    const t1 = await inv.peekNextTag(s.ctx, s.itemName.id);
    expect(t1).toEqual({ tagNo: 'GR0001', prefix: 'GR', next: 1 });
    expect(await inv.peekNextTag(s.ctx, s.itemName.id)).toEqual(t1);
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [{ itemNameId: s.itemName.id, gross: 1, less: 0, pcs: 1, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0 }] } as any);
    expect(entry.items[0]!.tagNo).toBe(t1.tagNo);
    expect((await inv.peekNextTag(s.ctx, s.itemName.id)).tagNo).toBe('GR0002');
  });

  it('TASK-98: bulk cancel — cancellable ones cancel, the rest are reported (open karigar issue, already cancelled, unknown id)', async () => {
    const s = await setup();
    const ok1 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const ok2 = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    const busy = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.createKarigarIssue(s.ctx, { karigarId: s.karigar.id, orderItemIds: [busy.items[0]!.id], goldFine: 0, silverFine: 0, cash: 0, online: 0 } as any);
    const done = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
    await orders.cancelOrder(s.ctx, done.id);
    const res = await orders.bulkCancelOrders(s.ctx, [ok1.id, busy.id, ok2.id, done.id, 999999, ok1.id]);
    expect([...res.cancelled].sort((a, b) => a - b)).toEqual([ok1.id, ok2.id].sort((a, b) => a - b));
    expect(res.failed.map((f) => f.id).sort((a, b) => a - b)).toEqual([busy.id, done.id, 999999].sort((a, b) => a - b));
    expect(res.failed.every((f) => f.reason.length > 0)).toBe(true);
    expect((await orders.getOrder(s.ctx, ok2.id)).status).toBe('CANCELLED');
    expect((await orders.getOrder(s.ctx, busy.id)).status).toBe('IN_PROCESS');
  });

  describe('karigar issue with samples (sampleIds — atomic issue + link)', () => {
    const issueBody = (karigarId: number, orderItemId: number, sampleIds: number[]): Parameters<typeof orders.createKarigarIssue>[1] =>
      ({ karigarId, orderItemIds: [orderItemId], goldFine: 0, silverFine: 0, cash: 0, online: 0, sampleIds });

    it('issues both samples in the same tx, links them to the issue, writes ISSUED movements; DTO lists them (detail + list)', async () => {
      const s = await setup();
      const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
      const a = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 2, tounchPercent: 90 });
      const b = await samples.createSample(s.ctx, { metal: 'SILVER', grossWt: 5, tounchPercent: 80, partyId: s.customer.id });
      const issue = await orders.createKarigarIssue(s.ctx, issueBody(s.karigar.id, order.items[0]!.id, [b.id, a.id]));

      expect(issue.samples).toEqual([
        { id: a.id, sampleNo: a.sampleNo, metal: 'GOLD', grossWt: '2.000', tounchPercent: '90.000', fine: '1.800' },
        { id: b.id, sampleNo: b.sampleNo, metal: 'SILVER', grossWt: '5.000', tounchPercent: '80.000', fine: '4.000' },
      ]);
      for (const id of [a.id, b.id]) {
        const d = await samples.getSample(s.ctx, id);
        expect(d.status).toBe('ISSUED');
        expect(d.karigar?.id).toBe(s.karigar.id);
        expect(d.karigarIssueId).toBe(issue.id);
        const last = d.movements.at(-1)!;
        expect(last.action).toBe('ISSUED');
        expect(last.karigar?.id).toBe(s.karigar.id);
        expect(last.note).toBe(`Karigar issue #${issue.issueNo}`);
      }
      expect((await samples.getSample(s.ctx, b.id)).party?.id).toBe(s.customer.id); // party kept
      expect((await orders.getKarigarIssue(s.ctx, issue.id)).samples?.map((x) => x.id)).toEqual([a.id, b.id]);
      const listed = await orders.listKarigarIssues(s.ctx, { page: 1, pageSize: 20 });
      expect(listed.items.find((i) => i.id === issue.id)!.samples?.map((x) => x.id)).toEqual([a.id, b.id]);

      // return keeps the link (history)
      await samples.returnSample(s.ctx, a.id, {});
      expect((await samples.getSample(s.ctx, a.id)).karigarIssueId).toBe(issue.id);
    });

    it('a non-available sample → 409 and the whole issue rolls back (no issue row, item still PENDING, other sample still IN_HAND)', async () => {
      const s = await setup();
      const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);
      const ok = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
      const melted = await samples.createSample(s.ctx, { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
      await samples.meltSample(s.ctx, melted.id, {});

      await expect(orders.createKarigarIssue(s.ctx, issueBody(s.karigar.id, order.items[0]!.id, [ok.id, melted.id])))
        .rejects.toMatchObject({ status: 409, message: `Sample #${melted.sampleNo} is not available` });

      expect(await db.karigarIssue.count({ where: { businessId: s.business.id } })).toBe(0);
      expect((await orders.getOrder(s.ctx, order.id)).items[0]!.status).toBe('PENDING');
      const okNow = await samples.getSample(s.ctx, ok.id);
      expect(okNow.status).toBe('IN_HAND');
      expect(okNow.karigarIssueId).toBeNull();
      expect(okNow.movements.map((m) => m.action)).toEqual(['CREATED']);
      expect(await db.ledgerEntry.count({ where: { source: 'KARIGAR_ISSUE' } })).toBe(0);
    });

    it('a cross-tenant sample → 404 and nothing is written', async () => {
      const s = await setup();
      const other = await createBusiness({ name: 'B' });
      const foreign = await samples.createSample(ctxFor(other.business.id, other.root.id), { metal: 'GOLD', grossWt: 1, tounchPercent: 90 });
      const order = await makeOrder(s.ctx, s.itemName.id, s.customer.id);

      await expect(orders.createKarigarIssue(s.ctx, issueBody(s.karigar.id, order.items[0]!.id, [foreign.id]))).rejects.toMatchObject({ status: 404 });

      expect(await db.karigarIssue.count()).toBe(0);
      const f = await db.sample.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(f.status).toBe('IN_HAND');
      expect(f.karigarIssueId).toBeNull();
    });
  });
});

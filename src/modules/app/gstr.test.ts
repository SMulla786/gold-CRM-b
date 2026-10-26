import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as svc from './reports';
import type { TenantContext } from '../../middleware/context';

/* GSTR-1 / GSTR-3B (TASK-73). Bills are inserted as rows — the reports aggregate stored fields, never recompute. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing'], limits: null, permissions: {}, impersonatorId: null,
});

const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const to = now;
const priorMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
const q = { from, to };

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.state.createMany({ data: [{ id: 27, name: 'Maharashtra' }, { id: 24, name: 'Gujarat' }] });
  await db.business.update({ where: { id: business.id }, data: { gstin: '27ABCDE1234F1Z5', stateId: 27 } });
  const party = async (over: Record<string, unknown>) => db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'P', mobile: String(9000000000 + Math.floor(Math.random() * 1e8)), countryCode: '+91', ...over } });
  return {
    business, root, ctx: ctxFor(business.id, root.id),
    reg: await party({ gstin: '27AAAAA0000A1Z5', stateId: 27 }), // registered, intra
    regInter: await party({ gstin: '24BBBBB0000B1Z5', stateId: 24 }), // registered, inter
    unregIntra: await party({ gstin: null, stateId: 27 }),
    unregInter: await party({ gstin: null, stateId: 24 }),
  };
}

let seq = 0;
async function mkBill(s: Awaited<ReturnType<typeof setup>>, o: any) {
  seq += 1;
  const taxable = o.taxable ?? 1000;
  const cgst = o.cgst ?? 0, sgst = o.sgst ?? 0, igst = o.igst ?? 0;
  const final = o.final ?? taxable + cgst + sgst + igst;
  return db.bill.create({
    data: {
      businessId: o.businessId ?? s.business.id, branchId: o.branchId ?? s.root.id, kind: o.kind ?? 'SELL', billType: o.billType ?? 'GST',
      billNo: o.billNo ?? `INV/25-26/${String(seq).padStart(4, '0')}`, seq, partyId: o.partyId, billDate: o.billDate ?? from,
      interState: o.interState ?? false, sub: taxable, taxable, gstPercent: o.gstPercent ?? 3, cgst, sgst, igst, total: final, final,
      status: o.status ?? 'ACTIVE', deletedAt: o.deletedAt ?? null,
      itcEligibility: o.itcEligibility, supplyCategory: o.supplyCategory, reverseCharge: o.reverseCharge, // undefined → schema defaults
      items: { create: [{ stockClass: o.stockClass ?? 'GOLD', description: 'ring', hsnCode: o.hsnCode ?? '7113', net: o.net ?? 10, gross: o.net ?? 10, fine: o.net ?? 10, pcs: o.pcs ?? 1, metalAmount: 0, labourAmount: 0, total: final }] },
    },
  });
}

describe('GSTR-1 classification', () => {
  it('B2B / B2CL / B2CS incl. the ₹1,00,000 boundary (= limit → B2CS)', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 }); // B2B
    await mkBill(s, { partyId: s.unregInter.id, interState: true, taxable: 145000, igst: 4350, final: 150000 }); // B2CL (>1L inter)
    await mkBill(s, { partyId: s.unregIntra.id, taxable: 5000, cgst: 75, sgst: 75 }); // B2CS intra
    await mkBill(s, { partyId: s.unregInter.id, interState: true, taxable: 97087, igst: 2913, final: 100000 }); // = limit → B2CS inter

    const r = await svc.gstr1(s.ctx, q);
    expect(r.b2b.map((x) => [x.gstin, x.pos])).toEqual([['27AAAAA0000A1Z5', '27']]);
    expect(r.b2cl).toHaveLength(1);
    expect(Number(r.b2cl[0]!.invValue)).toBe(150000);
    const supplyTypes = r.b2cs.map((x) => x.supplyType).sort();
    expect(supplyTypes).toEqual(['INTER', 'INTRA']); // the =limit inter bill landed in B2CS, not B2CL
    expect(r.gstin).toBe('27ABCDE1234F1Z5');
    expect(r.totals.invoices).toBe(4);
  });

  it('same-month delete → only in docIssue.cancelled', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, status: 'DELETED', deletedAt: now, taxable: 1000, cgst: 15, sgst: 15 });
    const r = await svc.gstr1(s.ctx, q);
    expect([r.b2b.length, r.b2cl.length, r.b2cs.length]).toEqual([0, 0, 0]);
    expect(r.docIssue.reduce((a, d) => a + d.cancelled, 0)).toBe(1);
  });

  it('prior-month bill deleted this month → CDNR (registered) / negative B2CS (unregistered)', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, billDate: priorMonth, status: 'DELETED', deletedAt: now, taxable: 1000, cgst: 15, sgst: 15 });
    await mkBill(s, { partyId: s.unregIntra.id, billDate: priorMonth, status: 'DELETED', deletedAt: now, taxable: 2000, cgst: 30, sgst: 30 });
    const r = await svc.gstr1(s.ctx, q);
    expect(r.cdnr).toHaveLength(1);
    expect(r.cdnr[0]!.noteDate).toBe(new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10)); // IST day of deletedAt (matches reports.ts +330min), not the UTC day
    const neg = r.b2cs.find((x) => Number(x.taxable) < 0)!;
    expect(Number(neg.taxable)).toBe(-2000);
  });

  it('HSN split B2B/B2C with GMS net qty; ROUGH excluded', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15, net: 12, hsnCode: '7113' }); // B2B gold
    await mkBill(s, { partyId: s.unregIntra.id, taxable: 500, cgst: 7.5, sgst: 7.5, net: 4, hsnCode: '7113' }); // B2C gold
    await mkBill(s, { partyId: s.reg.id, billType: 'ROUGH', taxable: 9999, final: 9999 }); // excluded from GST report
    const r = await svc.gstr1(s.ctx, q);
    expect([r.hsnB2b[0]!.uqc, r.hsnB2b[0]!.qty]).toEqual(['GMS', '12.000']);
    expect(r.hsnB2c[0]!.qty).toBe('4.000');
    expect(r.totals.invoices).toBe(2); // ROUGH not counted
  });

  it('other branch / business bills excluded', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 });
    await mkBill(s, { partyId: s.reg.id, branchId: s.root.id + 999, taxable: 5000, cgst: 75, sgst: 75, billNo: 'INV/OTHER/1' });
    const r = await svc.gstr1(s.ctx, q);
    expect(r.totals.invoices).toBe(1);
    expect(Number(r.totals.taxable)).toBe(1000);
  });
});

describe('GSTR-3B', () => {
  it('outward / ITC totals reconcile with the register range', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 });
    await mkBill(s, { partyId: s.unregIntra.id, taxable: 5000, cgst: 75, sgst: 75 });
    await mkBill(s, { partyId: s.reg.id, kind: 'PURCHASE', taxable: 2000, cgst: 30, sgst: 30, billNo: 'PUR/1' }); // ITC (party has GSTIN)
    await mkBill(s, { partyId: s.reg.id, billType: 'ROUGH', taxable: 800, final: 800 }); // nonGst

    const [r1, r3] = await Promise.all([svc.gstr1(s.ctx, q), svc.gstr3b(s.ctx, q)]);
    expect(r3.outward.taxable).toBe(r1.totals.taxable); // 6000
    expect([Number(r3.outward.cgst), Number(r3.outward.sgst)]).toEqual([90, 90]);
    expect([Number(r3.itc.cgst), Number(r3.itc.sgst)]).toEqual([30, 30]);
    expect(Number(r3.nonGst)).toBe(800);
    expect(Number(r3.netPayableIndicative)).toBe(180 - 60); // output 180 − itc 60
  });

  it('all-default bills: TASK-97 split leaves the previous totals identical', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 });
    await mkBill(s, { partyId: s.regInter.id, interState: true, taxable: 3000, igst: 90 });
    await mkBill(s, { partyId: s.reg.id, kind: 'PURCHASE', taxable: 2000, cgst: 30, sgst: 30, billNo: 'PUR/1' });
    await mkBill(s, { partyId: s.unregIntra.id, kind: 'PURCHASE', taxable: 500, cgst: 7.5, sgst: 7.5, billNo: 'PUR/2' }); // no GSTIN → no ITC (as before)
    const r = await svc.gstr3b(s.ctx, q);
    expect([r.outward.taxable, r.outward.cgst, r.outward.sgst, r.outward.igst]).toEqual(['4000.00', '15.00', '15.00', '90.00']);
    expect([r.itc.cgst, r.itc.sgst, r.itc.igst]).toEqual(['30.00', '30.00', '0.00']);
    expect(r.itc.eligible).toEqual({ cgst: '30.00', sgst: '30.00', igst: '0.00' });
    expect(r.itc.reversed).toEqual({ cgst: '0.00', sgst: '0.00', igst: '0.00' });
    expect(r.itc.ineligible).toEqual({ cgst: '0.00', sgst: '0.00', igst: '0.00' });
    expect(r.itc.taxable).toBe('2000.00');
    for (const k of ['zeroRated', 'nilExempt', 'nonGst', 'reverseCharge'] as const) expect(Number(r.outward[k]!.taxable)).toBe(0);
    expect(Number(r.netPayableIndicative)).toBe(120 - 60);
  });

  it('blocked 17(5) / ineligible ITC excluded from eligible + net; supply categories and RCM split out', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 }); // 3.1(a)
    await mkBill(s, { partyId: s.regInter.id, interState: true, taxable: 2000, igst: 60, supplyCategory: 'ZERO_RATED' }); // 3.1(b)
    await mkBill(s, { partyId: s.reg.id, taxable: 300, supplyCategory: 'NIL_EXEMPT' }); // 3.1(c)
    await mkBill(s, { partyId: s.reg.id, taxable: 400, supplyCategory: 'NON_GST' }); // 3.1(e)
    await mkBill(s, { partyId: s.reg.id, kind: 'PURCHASE', taxable: 1000, cgst: 15, sgst: 15, billNo: 'PUR/1' }); // eligible
    await mkBill(s, { partyId: s.reg.id, kind: 'PURCHASE', taxable: 2000, cgst: 30, sgst: 30, billNo: 'PUR/2', itcEligibility: 'BLOCKED_17_5' });
    await mkBill(s, { partyId: s.reg.id, kind: 'PURCHASE', taxable: 500, cgst: 7.5, sgst: 7.5, billNo: 'PUR/3', itcEligibility: 'INELIGIBLE' });
    await mkBill(s, { partyId: s.unregIntra.id, kind: 'PURCHASE', taxable: 100, cgst: 1.5, sgst: 1.5, billNo: 'PUR/4', reverseCharge: true }); // RCM, unregistered supplier
    const r = await svc.gstr3b(s.ctx, q);
    expect(r.outward.taxable).toBe('1000.00');
    expect([r.outward.zeroRated!.taxable, r.outward.zeroRated!.igst]).toEqual(['2000.00', '60.00']);
    expect(r.outward.nilExempt!.taxable).toBe('300.00');
    expect(r.outward.nonGst!.taxable).toBe('400.00');
    expect([r.outward.reverseCharge!.taxable, r.outward.reverseCharge!.cgst]).toEqual(['100.00', '1.50']);
    expect(r.itc.eligible).toEqual({ cgst: '16.50', sgst: '16.50', igst: '0.00' }); // PUR/1 + RCM PUR/4
    expect([r.itc.cgst, r.itc.sgst]).toEqual(['16.50', '16.50']);
    expect(r.itc.reversed).toEqual({ cgst: '30.00', sgst: '30.00', igst: '0.00' });
    expect(r.itc.ineligible).toEqual({ cgst: '7.50', sgst: '7.50', igst: '0.00' });
    expect(r.itc.taxable).toBe('3600.00');
    // output 30 + 60 (all GST sells) + RCM 3 − eligible 33
    expect(Number(r.netPayableIndicative)).toBe(60);
  });
});

describe('GSTR-1 portal JSON', () => {
  it('fp is MMYYYY and invoice dates are dd-mm-yyyy', async () => {
    const s = await setup();
    await mkBill(s, { partyId: s.reg.id, taxable: 1000, cgst: 15, sgst: 15 });
    const j = (await svc.gstr1Json(s.ctx, q)) as any;
    expect(j.fp).toBe(`${String(from.getUTCMonth() + 1).padStart(2, '0')}${from.getUTCFullYear()}`);
    expect(j.b2b[0].ctin).toBe('27AAAAA0000A1Z5');
    expect(j.b2b[0].inv[0].idt).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(j.b2b[0].inv[0].itms[0].itm_det.rt).toBe(3);
  });
});

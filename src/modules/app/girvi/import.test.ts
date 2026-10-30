import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { GIRVI_IMPORT_COLUMNS } from '../../../shared';
import { girviImportSampleCsv, importGirvi } from './import';
import type { TenantContext } from '../../../middleware/context';

// GIR-04: girvi bulk CSV import — dry run validates only, a real run imports only when every loan is valid, 2000-row cap.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, bank, ctx: ctxFor(business.id, root.id) };
}
const header = GIRVI_IMPORT_COLUMNS.join(',');
// one cash loan, one item: 10 g net @ 100% × 6000 = 60000 valuation
const row = (ref: string, over: Partial<Record<(typeof GIRVI_IMPORT_COLUMNS)[number], string>> = {}) => {
  const v: Record<string, string> = {
    loan_ref: ref, customer_name: 'Ramesh', mobile: '9876543210', address: '', issue_date: '2026-01-15', tenure_months: '12', rate_percent: '2', rate_period: 'MONTHLY',
    interest_type: 'SI', ci_period: '', method: 'DAY_WISE', principal: '50000', cash: '50000', online: '0', item_category: 'Gold', item_name: 'Chain',
    gross: '11', net: '10', purity: '100', rate: '6000', remark: '', ...over,
  };
  return GIRVI_IMPORT_COLUMNS.map((c) => v[c]).join(',');
};
const csv = (...rows: string[]) => [header, ...rows].join('\n');

describe('girvi import (GIR-04)', () => {
  it('sample CSV validates clean on a dry run (it is what the UI offers as the template)', async () => {
    const s = await setup();
    const r = await importGirvi(s.ctx, girviImportSampleCsv(), { dryRun: true, bankAccountId: s.bank.id });
    expect(r.loans.map((l) => [l.loanRef, l.items, l.errors])).toEqual([['L1', 2, []], ['L2', 1, []]]);
    expect(r).toMatchObject({ dryRun: true, valid: 2, imported: 0 });
  });

  it('dry run writes nothing; real run groups rows by loan_ref, creates the customer once and numbers loans like manual entry', async () => {
    const s = await setup();
    const file = csv(row('A'), row('A', { item_name: 'Ring' }), row('B', { customer_name: 'Sunita', mobile: '9123456780', principal: '30000', cash: '30000' }));
    const dry = await importGirvi(s.ctx, file, { dryRun: true });
    expect(dry).toMatchObject({ valid: 2, imported: 0 });
    expect(dry.loans.map((l) => l.existingCustomer)).toEqual([false, false]);
    expect(await db.girviBatch.count()).toBe(0);
    expect(await db.party.count()).toBe(0);

    const real = await importGirvi(s.ctx, file, { dryRun: false });
    expect(real).toMatchObject({ dryRun: false, valid: 2, imported: 2 });
    expect(real.loans.map((l) => l.girviNo)).toEqual([1, 2]);
    expect(await db.girviItem.count()).toBe(3);
    expect(await db.party.count({ where: { type: 'CUSTOMER' } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { source: 'GIRVI', asset: 'MONEY', direction: 'OUT' } })).toBe(2);

    // re-import: same mobile → existing customer reused, no duplicate party
    const again = await importGirvi(s.ctx, csv(row('C')), { dryRun: false });
    expect(again.loans[0]).toMatchObject({ existingCustomer: true, girviNo: 3 });
    expect(await db.party.count({ where: { type: 'CUSTOMER' } })).toBe(2);
  });

  it('one bad loan blocks the whole file; errors carry the CSV row and field', async () => {
    const s = await setup();
    const file = csv(
      row('OK'),
      row('BIG', { principal: '70000', cash: '70000' }), // over the 60000 valuation
      row('MIX', { mobile: '9000000001' }), row('MIX', { mobile: '9000000002', item_name: 'Ring' }), // rows of one loan disagree
      row('BADM', { mobile: '12' }),
    );
    const r = await importGirvi(s.ctx, file, { dryRun: false });
    expect(r).toMatchObject({ valid: 1, imported: 0 });
    const errs = Object.fromEntries(r.loans.map((l) => [l.loanRef, l.errors]));
    expect(errs.OK).toEqual([]);
    expect(errs.BIG).toEqual([expect.objectContaining({ row: 3, field: 'principal', message: 'Loan exceeds the item valuation' })]);
    expect(errs.MIX).toEqual(expect.arrayContaining([expect.objectContaining({ row: 5, field: 'mobile' })]));
    expect(errs.BADM).toEqual(expect.arrayContaining([expect.objectContaining({ row: 6, field: 'mobile' })]));
    expect(await db.girviBatch.count()).toBe(0);
  });

  it('rejects an empty file, missing required columns and more than 2000 rows', async () => {
    const s = await setup();
    await expect(importGirvi(s.ctx, header, { dryRun: true })).rejects.toMatchObject({ status: 400 });
    await expect(importGirvi(s.ctx, 'loan_ref,customer_name\nA,Ramesh', { dryRun: true })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('mobile') });
    // optional columns (address, ci_period, remark) may be left out
    const slim = GIRVI_IMPORT_COLUMNS.filter((c) => !['address', 'ci_period', 'remark'].includes(c));
    const slimRow = row('S').split(',').filter((_, i) => slim.includes(GIRVI_IMPORT_COLUMNS[i]!)).join(',');
    expect(await importGirvi(s.ctx, [slim.join(','), slimRow].join('\n'), { dryRun: true })).toMatchObject({ valid: 1 });

    const rows = Array.from({ length: 2001 }, (_, i) => row(`L${i}`));
    await expect(importGirvi(s.ctx, csv(...rows), { dryRun: true })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('2000') });
    expect(await importGirvi(s.ctx, csv(...rows.slice(0, 2000)), { dryRun: true })).toMatchObject({ valid: 2000 });
  });
});

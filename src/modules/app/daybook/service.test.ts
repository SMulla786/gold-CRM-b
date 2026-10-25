import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { prisma } from '../../../lib/prisma';
import * as ledger from '../../../lib/ledger';
import { closeDay, openDay } from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchId,
  branchIds: [branchId],
  activeBranchId: branchId,
  readOnly: false,
  modules: [],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

const moneyRow = (branchId: number, date: Date): ledger.LedgerEntryInput => ({ branchId, txnDate: date, asset: 'MONEY', direction: 'IN', amount: '100', source: 'INCOME_EXPENSE', sourceId: '1' });

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('daybook open/close', () => {
  it('open creates an OPEN row; close flips it to CLOSED', async () => {
    const { business, root } = await createBusiness({ name: 'DB' });
    const ctx = ctxFor(business.id, root.id);
    await openDay(ctx);
    const row = await prisma.dayBook.findFirstOrThrow({ where: { businessId: business.id, branchId: root.id } });
    expect(row.status).toBe('OPEN');
    await closeDay(ctx);
    expect((await prisma.dayBook.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('CLOSED');
  });

  it('a CLOSED branch-day blocks ledger postings (403 DAY_CLOSED); reopen unblocks', async () => {
    const { business, root } = await createBusiness({ name: 'DB2' });
    const ctx = ctxFor(business.id, root.id);
    const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
    const day = ledger.businessDate();

    await closeDay(ctx);
    await expect(prisma.$transaction((tx) => ledger.post(tx, lctx, [moneyRow(root.id, day)]))).rejects.toMatchObject({ status: 403, code: 'DAY_CLOSED' });
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.id } })).toBe(0);

    await openDay(ctx);
    await prisma.$transaction((tx) => ledger.post(tx, lctx, [moneyRow(root.id, day)]));
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.id } })).toBe(1);
  });

  it('a CLOSED day does not block another branch or another date', async () => {
    const { business, root } = await createBusiness({ name: 'DB3' });
    const ctx = ctxFor(business.id, root.id);
    const lctx = { businessId: business.id, branchIds: [root.id], userId: 1 };
    const today = ledger.businessDate();
    const yesterday = new Date(today.getTime() - 864e5);

    await closeDay(ctx, yesterday); // close only yesterday
    await prisma.$transaction((tx) => ledger.post(tx, lctx, [moneyRow(root.id, today)])); // today still open
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.id } })).toBe(1);
  });
});

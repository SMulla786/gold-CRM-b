import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness, createUser } from '../../../test/helpers/factory';
import { approveEnquiry, createEnquiry, listEnquiries, myEnquiries, rejectEnquiry } from './enquiry';
import type { TenantContext } from '../../middleware/context';

const ctxFor = (over: Partial<TenantContext> & { businessId: number; userId: number; branchIds: number[] }): TenantContext => ({
  level: 'ADMIN',
  isOwner: false,
  scopeBranchId: over.branchIds[0] ?? null,
  activeBranchId: over.branchIds[0] ?? null,
  readOnly: false,
  modules: [],
  limits: null,
  permissions: {},
  impersonatorId: null,
  ...over,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const b1 = await createBranch({ businessId: business.id, parentId: root.id, name: 'B1' });
  const perm = await db.permission.create({ data: { key: 'billing.sell_bill', module: 'billing', label: 'Sell Bill', sort: 1 } });
  const { user: staff } = await createUser({ businessId: business.id, branchId: b1.id, level: 'BRANCH_USER' });
  const { user: owner } = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const staffCtx = ctxFor({ businessId: business.id, userId: staff.id, branchIds: [b1.id], level: 'BRANCH_USER' });
  const ownerCtx = ctxFor({ businessId: business.id, userId: owner.id, branchIds: [root.id, b1.id], isOwner: true });
  return { business, root, b1, perm, staff, owner, staffCtx, ownerCtx };
}

const req = (over: Partial<{ view: boolean; edit: boolean; delete: boolean; reason: string }> = {}) => ({ permissionKey: 'billing.sell_bill', view: false, edit: false, delete: false, ...over });

describe('TASK-87 permission enquiries', () => {
  it('staff raises a request; a duplicate pending request 409s', async () => {
    const s = await setup();
    const dto = await createEnquiry(s.staffCtx, req({ edit: true, reason: 'need to bill' }));
    expect(dto.status).toBe('PENDING');
    expect(dto.edit).toBe(true);
    expect(await myEnquiries(s.staffCtx)).toHaveLength(1);
    await expect(createEnquiry(s.staffCtx, req({ edit: true }))).rejects.toMatchObject({ status: 409 });
  });

  it('approve merges the requested actions into the user override (edit ⇒ view) and a second decision 409s', async () => {
    const s = await setup();
    const dto = await createEnquiry(s.staffCtx, req({ edit: true }));
    const approved = await approveEnquiry(s.ownerCtx, dto.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedBy).toBeTruthy();
    const up = await db.userPermission.findUniqueOrThrow({ where: { userId_permissionId: { userId: s.staff.id, permissionId: s.perm.id } } });
    expect(up.canEdit).toBe(true);
    expect(up.canView).toBe(true); // edit ⇒ view
    expect(up.canDelete).toBe(false);
    await expect(approveEnquiry(s.ownerCtx, dto.id)).rejects.toMatchObject({ status: 409 });
  });

  it('a user cannot decide their own request (403); reject closes it and grants nothing', async () => {
    const s = await setup();
    const dto = await createEnquiry(s.staffCtx, req({ view: true }));
    await expect(approveEnquiry(s.staffCtx, dto.id)).rejects.toMatchObject({ status: 403 });
    const rejected = await rejectEnquiry(s.ownerCtx, dto.id, 'not now');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decisionNote).toBe('not now');
    expect(await db.userPermission.count({ where: { userId: s.staff.id } })).toBe(0);
  });

  it('a reviewer cannot see/decide a request from a user outside their branch subtree (404 / empty list)', async () => {
    const s = await setup();
    const dto = await createEnquiry(s.staffCtx, req({ view: true }));
    const { user: rootAdmin } = await createUser({ businessId: s.business.id, branchId: s.root.id, level: 'ADMIN' });
    const narrowCtx = ctxFor({ businessId: s.business.id, userId: rootAdmin.id, branchIds: [s.root.id] }); // subtree excludes B1
    await expect(approveEnquiry(narrowCtx, dto.id)).rejects.toMatchObject({ status: 404 });
    expect((await listEnquiries(narrowCtx, { page: 1, pageSize: 20 })).total).toBe(0);
    expect((await listEnquiries(s.ownerCtx, { page: 1, pageSize: 20 })).total).toBe(1); // owner sees it
  });
});

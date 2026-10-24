import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness, createUser } from '../../../test/helpers/factory';
import * as svc from './service';
import type { TenantContext } from '../../middleware/context';

// Covers TASK-5b security fixes 1–4 at the service layer.

const ctx = (over: Partial<TenantContext> & { businessId: number; branchIds: number[]; scopeBranchId: number; userId: number }): TenantContext => ({
  level: 'ADMIN',
  isOwner: false,
  activeBranchId: null,
  readOnly: false,
  modules: [],
  limits: { maxBranches: 100, maxUsers: 100 },
  permissions: {},
  impersonatorId: null,
  ...over,
});

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const pune = await createBranch({ businessId: business.id, parentId: root.id, name: 'Pune', isAdminNode: true });
  const mumbai = await createBranch({ businessId: business.id, parentId: root.id, name: 'Mumbai' }); // not an admin node
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
  const rootAdmin = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN' }); // non-owner, at root
  const puneAdmin = await createUser({ businessId: business.id, branchId: pune.id, level: 'ADMIN' });
  const cashier = await createUser({ businessId: business.id, branchId: pune.id, level: 'BRANCH_USER' });
  const allBranches = [root.id, pune.id, mumbai.id];
  return {
    business,
    root,
    pune,
    mumbai,
    owner,
    rootAdmin,
    puneAdmin,
    cashier,
    ownerCtx: ctx({ businessId: business.id, branchIds: allBranches, scopeBranchId: root.id, userId: owner.user.id, isOwner: true }),
    rootAdminCtx: ctx({ businessId: business.id, branchIds: allBranches, scopeBranchId: root.id, userId: rootAdmin.user.id }),
    puneCtx: ctx({ businessId: business.id, branchIds: [pune.id], scopeBranchId: pune.id, userId: puneAdmin.user.id }),
  };
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('TASK-5b(1) updateUser FK validation', () => {
  it('branchId outside subtree -> 404', async () => {
    const s = await setup();
    await expect(svc.updateUser(s.ownerCtx, s.cashier.user.id, { branchId: 999999 })).rejects.toMatchObject({ status: 404 });
  });
  it('roleId of another business -> 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bRole = await db.role.create({ data: { businessId: b.business.id, name: 'B-role' } });
    await expect(svc.updateUser(s.ownerCtx, s.cashier.user.id, { roleId: bRole.id })).rejects.toMatchObject({ status: 404 });
  });
  it('promoting to ADMIN on a non-admin-node branch -> 400', async () => {
    const s = await setup();
    await expect(svc.updateUser(s.ownerCtx, s.cashier.user.id, { level: 'ADMIN', branchId: s.mumbai.id })).rejects.toMatchObject({ status: 400 });
  });
});

describe('TASK-5b(2) owner protection & self-safety', () => {
  it('non-owner admin cannot edit the owner -> 403', async () => {
    const s = await setup();
    await expect(svc.updateUser(s.rootAdminCtx, s.owner.user.id, { name: 'x' })).rejects.toMatchObject({ status: 403 });
  });
  it('non-owner admin cannot block the owner -> 403', async () => {
    const s = await setup();
    await expect(svc.setUserStatus(s.rootAdminCtx, s.owner.user.id, 'BLOCKED')).rejects.toMatchObject({ status: 403 });
  });
  it('cannot block yourself -> 403', async () => {
    const s = await setup();
    await expect(svc.setUserStatus(s.ownerCtx, s.owner.user.id, 'BLOCKED')).rejects.toMatchObject({ status: 403 });
  });
  it('cannot change your own level -> 403', async () => {
    const s = await setup();
    await expect(svc.updateUser(s.rootAdminCtx, s.rootAdmin.user.id, { level: 'BRANCH_USER' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('TASK-5b(3) updateBranch protects own node / root', () => {
  it('toggling isAdminNode of your own node -> 400', async () => {
    const s = await setup();
    await expect(svc.updateBranch(s.puneCtx, s.pune.id, { isAdminNode: false })).rejects.toMatchObject({ status: 400 });
  });
  it('toggling isActive of the root branch -> 400', async () => {
    const s = await setup();
    await expect(svc.updateBranch(s.ownerCtx, s.root.id, { isActive: false })).rejects.toMatchObject({ status: 400 });
  });
  it('renaming a non-root, non-own branch is allowed', async () => {
    const s = await setup();
    const out = await svc.updateBranch(s.ownerCtx, s.mumbai.id, { name: 'Mumbai Central' });
    expect(out.name).toBe('Mumbai Central');
  });
});

describe('TASK-5b(4) role management is owner/root-only', () => {
  it('branch admin cannot create a role -> 403', async () => {
    const s = await setup();
    await expect(svc.createRole(s.puneCtx, 'Nope')).rejects.toMatchObject({ status: 403 });
  });
  it('owner can create a role', async () => {
    const s = await setup();
    const role = await svc.createRole(s.ownerCtx, 'Floor Staff');
    expect(role.name).toBe('Floor Staff');
  });
});

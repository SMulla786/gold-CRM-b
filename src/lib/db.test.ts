import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../test/helpers/db';
import { createBranch, createBusiness } from '../../test/helpers/factory';
import { scopedDb } from './db';
import type { TenantContext } from '../middleware/context';

const ctxFor = (businessId: number, branchIds: number[]): TenantContext => ({
  userId: 0,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchIds[0] ?? null,
  branchIds,
  activeBranchId: null,
  readOnly: false,
  modules: [],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

describe('scopedDb tenant isolation', () => {
  it('scopes findMany, injects businessId on create, hides cross-tenant rows by id', async () => {
    const A = await createBusiness({ name: 'A' });
    const B = await createBusiness({ name: 'B' });
    const ca = await db.counter.create({ data: { businessId: A.business.id, branchId: A.root.id, name: 'A-c' } });
    const cb = await db.counter.create({ data: { businessId: B.business.id, branchId: B.root.id, name: 'B-c' } });
    const sa = scopedDb(ctxFor(A.business.id, [A.root.id]));

    // where-merge: only own-business rows
    expect((await sa.counter.findMany()).map((c) => c.id)).toEqual([ca.id]);

    // create injects businessId when not supplied
    const created = await sa.counter.create({ data: { branchId: A.root.id, name: 'A-c2' } as never });
    expect(created.businessId).toBe(A.business.id);

    // cross-tenant lookup by id -> null (service turns into 404); own lookup works
    expect(await sa.counter.findUnique({ where: { id: cb.id } })).toBeNull();
    expect(await sa.counter.findUnique({ where: { id: ca.id } })).not.toBeNull();

    // cross-tenant update by id -> P2025 (not found)
    await expect(sa.counter.update({ where: { id: cb.id }, data: { name: 'x' } })).rejects.toMatchObject({ code: 'P2025' });
  });

  it('branch user cannot read a sibling-branch row by id (same business)', async () => {
    const A = await createBusiness({ name: 'A' });
    const sib = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'Sib' });
    const own = await db.counter.create({ data: { businessId: A.business.id, branchId: A.root.id, name: 'own' } });
    const other = await db.counter.create({ data: { businessId: A.business.id, branchId: sib.id, name: 'other' } });
    const branchUser: TenantContext = { ...ctxFor(A.business.id, [A.root.id]), level: 'BRANCH_USER' };

    expect(await scopedDb(branchUser).counter.findUnique({ where: { id: own.id } })).not.toBeNull();
    expect(await scopedDb(branchUser).counter.findUnique({ where: { id: other.id } })).toBeNull();
  });

  it('TASK-4b(1) Branch self-scope: a branch-admin cannot read parent/sibling branches by id', async () => {
    const A = await createBusiness({ name: 'A' }); // root = HQ
    const pune = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'Pune', isAdminNode: true });
    const kothrud = await createBranch({ businessId: A.business.id, parentId: pune.id, name: 'Kothrud' });
    const mumbai = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'Mumbai' });
    const puneAdmin = ctxFor(A.business.id, [pune.id, kothrud.id]); // subtree of Pune

    const sp = scopedDb(puneAdmin);
    expect(await sp.branch.findUnique({ where: { id: pune.id } })).not.toBeNull();
    expect(await sp.branch.findUnique({ where: { id: kothrud.id } })).not.toBeNull();
    expect(await sp.branch.findUnique({ where: { id: A.root.id } })).toBeNull(); // parent
    expect(await sp.branch.findUnique({ where: { id: mumbai.id } })).toBeNull(); // sibling
    expect((await sp.branch.findMany()).map((b) => b.id).sort()).toEqual([pune.id, kothrud.id].sort());
  });

  it('TASK-4b(2) create on a branch-owned model rejects a branchId outside the subtree -> 404', async () => {
    const A = await createBusiness({ name: 'A' });
    const mumbai = await createBranch({ businessId: A.business.id, parentId: A.root.id, name: 'Mumbai' });
    const hqOnly = ctxFor(A.business.id, [A.root.id]); // subtree excludes Mumbai

    await expect(scopedDb(hqOnly).counter.create({ data: { branchId: mumbai.id, name: 'x' } as never })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const ok = await scopedDb(hqOnly).counter.create({ data: { branchId: A.root.id, name: 'ok' } as never });
    expect(ok.businessId).toBe(A.business.id);
  });
});

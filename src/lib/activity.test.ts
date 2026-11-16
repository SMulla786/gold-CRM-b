import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../test/helpers/db';
import { createBusiness, createUser } from '../../test/helpers/factory';
import { logActivity } from './activity';
import type { TenantContext } from '../middleware/context';

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

// G7 audit M5: an action taken while impersonating must name the Super Admin in the business's audit trail.
describe('logActivity', () => {
  it('records the impersonator in meta (merged with the caller meta); a normal action is unchanged', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true });
    const base = { businessId: business.id, scopeBranchId: root.id, activeBranchId: root.id, userId: owner.user.id } as TenantContext;
    const row = { module: 'UDHAR', action: 'CREATED' as const, entity: 'UDHAR', entityId: '1', summary: 's' };

    await db.$transaction((tx) => logActivity(tx, { ...base, impersonatorId: 7 }, { ...row, entityId: 'imp', meta: { remark: 'x' } }));
    await db.$transaction((tx) => logActivity(tx, { ...base, impersonatorId: 7 }, { ...row, entityId: 'imp-bare' }));
    await db.$transaction((tx) => logActivity(tx, { ...base, impersonatorId: null }, { ...row, entityId: 'own' }));

    const byId = Object.fromEntries((await db.activityLog.findMany({ where: { businessId: business.id } })).map((r) => [r.entityId, r]));
    expect(byId.imp?.meta).toEqual({ remark: 'x', impersonatorId: 7 });
    expect(byId['imp-bare']?.meta).toEqual({ impersonatorId: 7 });
    expect(byId.own?.meta).toBeNull();
    expect(byId.imp?.userId).toBe(owner.user.id);
  });
});

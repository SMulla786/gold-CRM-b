import { describe, expect, it } from 'vitest';
import { HttpError } from './error';
import { assertWithinLimit, hasPermission } from './guards';
import type { TenantContext } from './context';

const base = (over: Partial<TenantContext>): TenantContext => ({
  userId: 1,
  level: 'BRANCH_USER',
  isOwner: false,
  businessId: 1,
  scopeBranchId: 1,
  branchIds: [1],
  activeBranchId: 1,
  readOnly: false,
  modules: ['billing'],
  limits: null,
  permissions: {},
  impersonatorId: null,
  ...over,
});

describe('hasPermission', () => {
  it('admins and super admins pass any key', () => {
    expect(hasPermission(base({ level: 'ADMIN' }), 'billing.sell_bill', 'delete')).toBe(true);
    expect(hasPermission(base({ level: 'SUPER_ADMIN' }), 'anything.at_all', 'edit')).toBe(true);
  });
  it('branch user checked against the permission map, action-specific', () => {
    const ctx = base({ permissions: { 'billing.sell_bill': { view: true, edit: false } } });
    expect(hasPermission(ctx, 'billing.sell_bill', 'view')).toBe(true);
    expect(hasPermission(ctx, 'billing.sell_bill', 'edit')).toBe(false);
    expect(hasPermission(ctx, 'billing.sell_bill', 'delete')).toBe(false);
    expect(hasPermission(ctx, 'inventory.all_stock', 'view')).toBe(false);
  });
});

describe('assertWithinLimit', () => {
  it('passes under the limit and when no limit', () => {
    expect(() => assertWithinLimit(4, 5, 'users')).not.toThrow();
    expect(() => assertWithinLimit(99, null, 'users')).not.toThrow();
  });
  it('throws PLAN_LIMIT at or over the limit', () => {
    expect(() => assertWithinLimit(5, 5, 'branches')).toThrow(HttpError);
    try {
      assertWithinLimit(6, 5, 'branches');
    } catch (e) {
      expect((e as HttpError).code).toBe('PLAN_LIMIT');
      expect((e as HttpError).status).toBe(403);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { CORE_MODULES, buildPermissionMap, inSubtree, otpStubEnabled, resolveAccess } from './logic';

describe('otpStubEnabled (ISS-14)', () => {
  it('prints only in development with OTP_STUB=1', () => {
    expect(otpStubEnabled('development', '1')).toBe(true);
    expect(otpStubEnabled('development', undefined)).toBe(false);
    expect(otpStubEnabled('development', '0')).toBe(false);
    expect(otpStubEnabled('development', 'true')).toBe(false);
    expect(otpStubEnabled('test', '1')).toBe(false);
    expect(otpStubEnabled('production', '1')).toBe(false);
  });
});

describe('buildPermissionMap', () => {
  const role = [{ key: 'billing.sell_bill', canView: true, canEdit: true, canDelete: false }];
  it('maps role grants', () => {
    expect(buildPermissionMap(role, [])).toEqual({ 'billing.sell_bill': { view: true, edit: true, delete: false } });
  });
  it('override replaces the role value for that key', () => {
    const out = buildPermissionMap(role, [{ key: 'billing.sell_bill', canView: true, canEdit: false, canDelete: false }]);
    expect(out['billing.sell_bill']).toEqual({ view: true, edit: false, delete: false });
  });
});

describe('inSubtree', () => {
  it('true for descendants and self, false for parent/sibling', () => {
    expect(inSubtree('/1/4/9/', '/1/4/')).toBe(true);
    expect(inSubtree('/1/4/', '/1/4/')).toBe(true);
    expect(inSubtree('/1/', '/1/4/')).toBe(false);
    expect(inSubtree('/1/5/', '/1/4/')).toBe(false);
  });
});

describe('resolveAccess', () => {
  const sub = { planName: 'Pro', endsAt: new Date('2030-01-01'), modules: ['billing', 'inventory'] };
  it('active: core + plan modules, not read-only', () => {
    const r = resolveAccess(true, sub);
    expect(r.subscription).toEqual({ planName: 'Pro', endsAt: sub.endsAt.toISOString(), readOnly: false, adEligible: false });
    expect(r.modules).toEqual(expect.arrayContaining([...CORE_MODULES, 'billing', 'inventory']));
  });
  it('inactive: read-only, core modules only', () => {
    const r = resolveAccess(false, sub);
    expect(r.subscription?.readOnly).toBe(true);
    expect(r.modules).toEqual(CORE_MODULES);
  });
  it('adEligible only when active AND the current term is ad-supported', () => {
    expect(resolveAccess(true, sub, true).subscription?.adEligible).toBe(true);
    expect(resolveAccess(false, sub, true).subscription?.adEligible).toBe(false); // expired / suspended
    expect(resolveAccess(true, sub, false).subscription?.adEligible).toBe(false);
  });
  it('no subscription: null summary, core modules', () => {
    const r = resolveAccess(false, null);
    expect(r.subscription).toBeNull();
    expect(r.modules).toEqual(CORE_MODULES);
  });
});

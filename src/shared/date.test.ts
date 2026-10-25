import { describe, expect, it } from 'vitest';
import { businessDayISO } from './date';

describe('businessDayISO (BUG-17)', () => {
  it('is the IST day, not the UTC day, just after IST midnight', () => {
    // 18:52 UTC on the 25th = 00:22 IST on the 26th
    expect(businessDayISO(new Date('2026-10-25T18:52:00Z'))).toBe('2026-10-26');
  });
  it('matches the UTC day once IST has caught up', () => {
    expect(businessDayISO(new Date('2026-10-26T06:00:00Z'))).toBe('2026-10-26');
  });
  it('flips exactly at 18:30 UTC', () => {
    expect(businessDayISO(new Date('2026-10-25T18:29:59Z'))).toBe('2026-10-25');
    expect(businessDayISO(new Date('2026-10-25T18:30:00Z'))).toBe('2026-10-26');
  });
});

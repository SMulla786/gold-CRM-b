import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from './error';
import { rateLimit } from './rateLimit';

const run = (mw: ReturnType<typeof rateLimit>, ip: string) => {
  const next = vi.fn();
  const res = { setHeader: vi.fn() } as unknown as Response;
  mw({ ip } as Request, res, next);
  return next;
};

describe('rateLimit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to max per window, then blocks with 429, and resets after the window', () => {
    const mw = rateLimit({ max: 2, windowMs: 1000, key: (r) => r.ip ?? '' });
    expect(run(mw, 'a').mock.calls.length).toBe(1); // 1st ok
    expect(run(mw, 'a').mock.calls.length).toBe(1); // 2nd ok
    expect(() => run(mw, 'a')).toThrow(HttpError); // 3rd blocked
    vi.advanceTimersByTime(1001);
    expect(run(mw, 'a').mock.calls.length).toBe(1); // window rolled over → ok again
  });

  it('keys independently (one IP hitting the limit does not block another)', () => {
    const mw = rateLimit({ max: 1, windowMs: 1000, key: (r) => r.ip ?? '' });
    run(mw, 'a');
    expect(() => run(mw, 'a')).toThrow(HttpError);
    expect(run(mw, 'b').mock.calls.length).toBe(1); // different key, still allowed
  });
});

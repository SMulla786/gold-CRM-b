import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { errorHandler } from './error';

/** [status, code] errorHandler answers for err. */
function answer(err: unknown): [number, string] {
  let out: [number, string] = [0, ''];
  const res = { status: (n: number) => ({ json: (b: { error: { code: string } }) => void (out = [n, b.error.code]) }) };
  errorHandler(err, { method: 'POST', originalUrl: '/test', id: 'test' } as never, res as never, () => {});
  return out;
}
const prismaErr = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

describe('errorHandler: Prisma known errors', () => {
  it('FK violation (P2003), write conflict (P2034) and a raw-query deadlock (P2010 / 40P01) → 409, never a 500', () => {
    expect([prismaErr('P2003'), prismaErr('P2034'), prismaErr('P2010', { code: '40P01' })].map(answer)).toEqual(Array(3).fill([409, 'CONFLICT']));
  });

  it('any other raw-query failure stays a 500', () => {
    expect(answer(prismaErr('P2010', { code: '42601' }))).toEqual([500, 'INTERNAL']);
  });
});

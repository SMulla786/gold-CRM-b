import supertest from 'supertest';
import { createApp } from '../../src/app';
import { TEST_PASSWORD } from './factory';

/** One app instance for all suites (createApp does not listen). */
export const api = supertest(createApp());

export const bearer = (token: string) => `Bearer ${token}`;

/** Logs in and returns the access token + the rotated ju_rt cookie(s). */
export async function loginAs(login: string, password: string = TEST_PASSWORD) {
  const res = await api.post('/api/auth/login').send({ login, password });
  return {
    res,
    token: res.body?.accessToken as string | undefined,
    cookie: (res.headers['set-cookie'] ?? []) as unknown as string[],
  };
}

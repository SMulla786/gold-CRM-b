import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { checkedGeo } from '../../lib/geo';
import { id as idSchema, signupBody } from '../../shared';
import type { GeoDto, SignupRequestDto } from '../../shared';
import { HttpError } from '../../middleware/error';
import { seedPasswordHash } from '../../../prisma/seed-password';
import { seedBase } from '../../../prisma/seed-base';

export const publicRouter = Router();

const SEED_CALL_LIMIT = 3;
const SEED_LOCK_KEY = 7_300_001; // single-bigint advisory key space; app locks elsewhere use the (int4, int4) space

/** Bootstrap for a fresh server = `npm run db:seed` without demo data: states, districts, permissions, system roles, plans,
 *  HSN (all idempotent), plus the Super Admin from SEED_SUPERADMIN_* env unless any Super Admin already exists.
 *  Safe to leave public: the password only ever comes from the server's env, never the request.
 *  Callable SEED_CALL_LIMIT times in total (failed calls included), then 403 forever. */
publicRouter.get('/seed-superadmin', async (_req, res) => {
  // one ActivityLog row per call, so the limit survives restarts; the lock stops a burst slipping past it
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY}::int8)`;
    const calls = await tx.activityLog.count({ where: { businessId: null, module: 'PLATFORM', entity: 'SEED_SUPERADMIN' } });
    if (calls >= SEED_CALL_LIMIT) throw new HttpError(403, 'SEED_LIMIT', `This endpoint can only be called ${SEED_CALL_LIMIT} times`);
    await tx.activityLog.create({
      data: { module: 'PLATFORM', action: 'CREATED', entity: 'SEED_SUPERADMIN', entityId: String(calls + 1), summary: `seed-superadmin call ${calls + 1}/${SEED_CALL_LIMIT}` },
    });
  });
  const exists = !!(await prisma.user.findFirst({ where: { level: 'SUPER_ADMIN' }, select: { id: true } }));
  // checked before any write, same rules as `npm run db:seed`; the error text never contains the password
  const passwordHash = exists
    ? null
    : await seedPasswordHash().catch((e: Error) => {
        throw new HttpError(500, 'SEED_CONFIG', e.message);
      });
  const { districts, superAdmin } = await seedBase(prisma, { passwordHash });
  if (superAdmin && superAdmin.level !== 'SUPER_ADMIN')
    throw new HttpError(409, 'SEED_CONFIG', `SEED_SUPERADMIN_USERNAME "${superAdmin.username}" already belongs to another user`);
  res.status(exists ? 200 : 201).json({
    created: !exists,
    ...(superAdmin ? { username: superAdmin.username } : { message: 'Super admin already present' }),
    districts: { created: districts.created, updated: districts.updated.length, unchanged: districts.unchanged },
  });
});

publicRouter.get('/states', async (_req, res) => {
  const states = await prisma.state.findMany({ orderBy: { name: 'asc' } });
  res.json(states.map((s): GeoDto => ({ id: s.id, name: s.name })));
});

publicRouter.get('/states/:id/districts', async (req, res) => {
  const stateId = idSchema.parse(req.params.id);
  const districts = await prisma.district.findMany({ where: { stateId }, orderBy: { name: 'asc' } });
  res.json(districts.map((d): GeoDto => ({ id: d.id, name: d.name })));
});

publicRouter.post('/signup', async (req, res) => {
  const b = signupBody.parse(req.body);
  await checkedGeo({ stateId: b.stateId, districtId: b.districtId }); // a bad pair would only fail later, at approval
  const row = await prisma.signupRequest.create({
    data: {
      shopName: b.shopName,
      ownerName: b.ownerName,
      countryCode: b.countryCode,
      whatsapp: b.whatsapp,
      email: b.email ?? null,
      address: b.address,
      stateId: b.stateId,
      districtId: b.districtId ?? null,
    },
  });
  res.status(201).json({ id: row.id, status: row.status } satisfies Pick<SignupRequestDto, 'id' | 'status'>);
});

import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { id as idSchema, signupBody } from '../../shared';
import type { GeoDto, SignupRequestDto } from '../../shared';

export const publicRouter = Router();

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

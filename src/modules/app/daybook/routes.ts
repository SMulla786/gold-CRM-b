import { Router } from 'express';
import { z } from 'zod';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import * as daybook from './service';

export const daybookRouter = Router();
const DAYBOOK = 'daybook.all_in_one';
const dayActionBody = z.object({ date: z.coerce.date().optional() }); // omitted = today

daybookRouter.post('/daybook/open', requirePermission(DAYBOOK, 'edit'), requireMpin, async (req, res) => res.json(await daybook.openDay(req.ctx!, dayActionBody.parse(req.body).date)));
daybookRouter.post('/daybook/close', requirePermission(DAYBOOK, 'edit'), requireMpin, async (req, res) => res.json(await daybook.closeDay(req.ctx!, dayActionBody.parse(req.body).date)));

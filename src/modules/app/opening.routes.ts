import { Router } from 'express';
import { requireMpin, requirePermission } from '../../middleware/guards';
import { openingBalanceBody } from '../../shared';
import * as opening from './opening';

export const openingRouter = Router();
const MISC = 'settings.misc';

openingRouter.post('/opening-balances', requirePermission(MISC, 'edit'), requireMpin, async (req, res) => res.status(201).json(await opening.createOpeningBalances(req.ctx!, openingBalanceBody.parse(req.body))));
openingRouter.get('/opening-balances', requirePermission(MISC, 'view'), async (req, res) => res.json(await opening.listOpeningBalances(req.ctx!)));
openingRouter.delete('/opening-balances/:sourceId', requirePermission(MISC, 'delete'), requireMpin, async (req, res) => {
  await opening.deleteOpeningBalances(req.ctx!, String(req.params.sourceId));
  res.status(204).end();
});

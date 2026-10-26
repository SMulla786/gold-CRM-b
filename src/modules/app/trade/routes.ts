import { Router } from 'express';
import { requireMpin, requirePermission } from '../../../middleware/guards';
import { bhavBookingBody, bhavListQuery, buySellBody, buySellListQuery, exchangeBody, exchangeListQuery, id as idSchema, kachaBalanceQuery, kachaListQuery, kachaProcessBody } from '../../../shared';
import * as exchange from './exchange';
import * as kacha from './kacha';
import * as buysell from './buysell';
import * as bhav from './bhav';

export const tradeRouter = Router();
const EX = 'exchange.entry';
const EX_LIST = 'exchange.list';
const BS = 'buy_sell.entry';
const BS_LIST = 'buy_sell.list';
const BHAV = 'buy_sell.bhav_booking';

// ───────────── Exchange ─────────────
tradeRouter.post('/exchange', requirePermission(EX, 'edit'), async (req, res) => res.status(201).json(await exchange.createExchange(req.ctx!, exchangeBody.parse(req.body))));
tradeRouter.get('/exchange', requirePermission(EX_LIST, 'view'), async (req, res) => res.json(await exchange.listExchange(req.ctx!, exchangeListQuery.parse(req.query))));
tradeRouter.get('/exchange/:id', requirePermission(EX_LIST, 'view'), async (req, res) => res.json(await exchange.getExchange(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.get('/exchange/:id/history', requirePermission(EX_LIST, 'view'), async (req, res) => res.json(await exchange.exchangeHistory(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.put('/exchange/:id', requirePermission(EX, 'edit'), requireMpin, async (req, res) => res.json(await exchange.updateExchange(req.ctx!, idSchema.parse(req.params.id), exchangeBody.parse(req.body))));
tradeRouter.delete('/exchange/:id', requirePermission(EX, 'delete'), requireMpin, async (req, res) => {
  await exchange.deleteExchange(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── Kacha processing ─────────────
tradeRouter.post('/kacha/process', requirePermission(EX, 'edit'), requireMpin, async (req, res) => res.status(201).json(await kacha.processKacha(req.ctx!, kachaProcessBody.parse(req.body))));
tradeRouter.get('/kacha', requirePermission(EX_LIST, 'view'), async (req, res) => res.json(await kacha.listKacha(req.ctx!, kachaListQuery.parse(req.query))));
tradeRouter.get('/kacha/balance', requirePermission(EX_LIST, 'view'), async (req, res) => res.json(await kacha.kachaBalanceCard(req.ctx!, kachaBalanceQuery.parse(req.query))));
tradeRouter.post('/kacha/:id/revert', requirePermission(EX, 'edit'), requireMpin, async (req, res) => res.json(await kacha.revertKacha(req.ctx!, idSchema.parse(req.params.id))));

// ───────────── Buy-sell ─────────────
tradeRouter.post('/buy-sell', requirePermission(BS, 'edit'), async (req, res) => res.status(201).json(await buysell.createBuySell(req.ctx!, buySellBody.parse(req.body))));
tradeRouter.get('/buy-sell', requirePermission(BS_LIST, 'view'), async (req, res) => res.json(await buysell.listBuySell(req.ctx!, buySellListQuery.parse(req.query))));
tradeRouter.get('/buy-sell/:id', requirePermission(BS_LIST, 'view'), async (req, res) => res.json(await buysell.getBuySell(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.get('/buy-sell/:id/history', requirePermission(BS_LIST, 'view'), async (req, res) => res.json(await buysell.buySellHistory(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.put('/buy-sell/:id', requirePermission(BS, 'edit'), requireMpin, async (req, res) => res.json(await buysell.updateBuySell(req.ctx!, idSchema.parse(req.params.id), buySellBody.parse(req.body))));
tradeRouter.delete('/buy-sell/:id', requirePermission(BS, 'delete'), requireMpin, async (req, res) => {
  await buysell.deleteBuySell(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

// ───────────── Bhav booking ─────────────
tradeRouter.post('/bhav-booking', requirePermission(BHAV, 'edit'), async (req, res) => res.status(201).json(await bhav.createBhav(req.ctx!, bhavBookingBody.parse(req.body))));
tradeRouter.get('/bhav-booking', requirePermission(BHAV, 'view'), async (req, res) => res.json(await bhav.listBhav(req.ctx!, bhavListQuery.parse(req.query))));
tradeRouter.get('/bhav-booking/:id', requirePermission(BHAV, 'view'), async (req, res) => res.json(await bhav.getBhav(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.post('/bhav-booking/:id/cancel', requirePermission(BHAV, 'edit'), requireMpin, async (req, res) => res.json(await bhav.cancelBhav(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.get('/bhav-booking/:id/history', requirePermission(BHAV, 'view'), async (req, res) => res.json(await bhav.bhavHistory(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.put('/bhav-booking/:id', requirePermission(BHAV, 'edit'), requireMpin, async (req, res) => res.json(await bhav.updateBhav(req.ctx!, idSchema.parse(req.params.id), bhavBookingBody.parse(req.body))));
tradeRouter.post('/bhav-booking/:id/undeliver', requirePermission(BHAV, 'edit'), requireMpin, async (req, res) => res.json(await bhav.undeliverBhav(req.ctx!, idSchema.parse(req.params.id))));
tradeRouter.post('/bhav-booking/:id/verify', requirePermission(BHAV, 'edit'), async (req, res) => res.json(await bhav.verifyBhav(req.ctx!, idSchema.parse(req.params.id), true)));
tradeRouter.post('/bhav-booking/:id/unverify', requirePermission(BHAV, 'edit'), async (req, res) => res.json(await bhav.verifyBhav(req.ctx!, idSchema.parse(req.params.id), false)));
tradeRouter.delete('/bhav-booking/:id', requirePermission(BHAV, 'delete'), requireMpin, async (req, res) => {
  await bhav.deleteBhav(req.ctx!, idSchema.parse(req.params.id));
  res.status(204).end();
});

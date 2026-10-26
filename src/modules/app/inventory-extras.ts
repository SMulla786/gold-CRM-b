import { Prisma } from '@prisma/client';
import type { SetStockLog, TagTemplate } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { kachaBalance } from '../../lib/kacha';
import * as ledger from '../../lib/ledger';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { RATE_UNIT_GRAMS, printerSettingsBody } from '../../shared';
import type { AllStockSummaryDto, Paged, PrinterSettingsDto, SetStockCard, SetStockLogDto, TagTemplateDto, setStockBody, tagTemplateBody, updateTagTemplateBody } from '../../shared';
import { currentRates } from './service';
import { dashboard } from './reports';

/**
 * Inventory extras (task97): printer settings, tag templates, All Stock Summary + Set Stock.
 * TagTemplate / SetStockLog are not in scopedDb's model map, so every query pins businessId explicitly.
 */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const wt = (d: Prisma.Decimal) => d.toFixed(3);
const money = (d: Prisma.Decimal) => d.toFixed(2);
/** Admin with X-Branch-Id:all → whole subtree; otherwise just the active branch (same rule as the dashboard). */
const branchFilter = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);

// ───────────── Printer settings ─────────────

const PRINTER_KEY = 'inventory.printer';
const printerWhere = (ctx: TenantContext) => ({ businessId_branchId_key: { businessId: ctx.businessId!, branchId: 0, key: PRINTER_KEY } });

export async function getPrinterSettings(ctx: TenantContext): Promise<PrinterSettingsDto> {
  const row = await scopedDb(ctx).setting.findUnique({ where: printerWhere(ctx) });
  // A stored value that no longer validates falls back to defaults rather than breaking tag printing.
  const parsed = printerSettingsBody.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : printerSettingsBody.parse({});
}

export async function putPrinterSettings(ctx: TenantContext, body: PrinterSettingsDto): Promise<PrinterSettingsDto> {
  await scopedDb(ctx).setting.upsert({
    where: printerWhere(ctx),
    update: { value: body as object, updatedById: ctx.userId },
    create: { branchId: 0, key: PRINTER_KEY, value: body as object, updatedById: ctx.userId } as never,
  });
  return getPrinterSettings(ctx);
}

// ───────────── Tag templates ─────────────

type TemplateBody = z.output<typeof tagTemplateBody>;
type TemplatePatch = z.output<typeof updateTagTemplateBody>;
type TemplateRow = TagTemplate;

const templateDto = (t: TemplateRow): TagTemplateDto => ({
  id: t.id,
  name: t.name,
  widthMm: Number(t.widthMm),
  heightMm: Number(t.heightMm),
  shape: t.shape as TagTemplateDto['shape'],
  direction: t.direction as TagTemplateDto['direction'],
  neckWidthMm: t.neckWidthMm != null ? Number(t.neckWidthMm) : null,
  elements: t.elements as unknown as TagTemplateDto['elements'],
  appliesTo: t.appliesTo,
  isActive: t.isActive,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

async function findTemplate(ctx: TenantContext, id: number): Promise<TemplateRow> {
  const t = await prisma.tagTemplate.findFirst({ where: { id, businessId: ctx.businessId! } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Tag template not found');
  return t;
}

export async function listTagTemplates(ctx: TenantContext): Promise<TagTemplateDto[]> {
  const rows = await prisma.tagTemplate.findMany({ where: { businessId: ctx.businessId! }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  return rows.map(templateDto);
}

export const getTagTemplate = async (ctx: TenantContext, id: number): Promise<TagTemplateDto> => templateDto(await findTemplate(ctx, id));

const templateData = (b: TemplatePatch) => ({
  ...(b.name !== undefined ? { name: b.name } : {}),
  ...(b.widthMm !== undefined ? { widthMm: b.widthMm } : {}),
  ...(b.heightMm !== undefined ? { heightMm: b.heightMm } : {}),
  ...(b.shape !== undefined ? { shape: b.shape } : {}),
  ...(b.direction !== undefined ? { direction: b.direction } : {}),
  ...(b.neckWidthMm !== undefined ? { neckWidthMm: b.neckWidthMm } : {}),
  ...(b.elements !== undefined ? { elements: b.elements as Prisma.InputJsonValue } : {}),
  ...(b.appliesTo !== undefined ? { appliesTo: b.appliesTo } : {}),
});

export async function createTagTemplate(ctx: TenantContext, body: TemplateBody): Promise<TagTemplateDto> {
  const t = await prisma.tagTemplate.create({ data: { businessId: ctx.businessId!, createdById: ctx.userId, ...templateData(body), name: body.name, widthMm: body.widthMm, heightMm: body.heightMm, elements: body.elements as Prisma.InputJsonValue } });
  return templateDto(t);
}

export async function updateTagTemplate(ctx: TenantContext, id: number, body: TemplatePatch): Promise<TagTemplateDto> {
  await findTemplate(ctx, id);
  return templateDto(await prisma.tagTemplate.update({ where: { id }, data: templateData(body) }));
}

export async function deleteTagTemplate(ctx: TenantContext, id: number): Promise<void> {
  await findTemplate(ctx, id);
  await prisma.tagTemplate.delete({ where: { id } });
}

/** One active template per stock class: activating this one deactivates every other active template that shares a class. */
export async function activateTagTemplate(ctx: TenantContext, id: number): Promise<TagTemplateDto> {
  const t = await findTemplate(ctx, id);
  if (t.appliesTo.length === 0) throw new HttpError(400, 'VALIDATION', 'Choose at least one stock class before activating');
  await prisma.$transaction([
    prisma.tagTemplate.updateMany({ where: { businessId: ctx.businessId!, id: { not: id }, isActive: true, appliesTo: { hasSome: t.appliesTo } }, data: { isActive: false } }),
    prisma.tagTemplate.update({ where: { id }, data: { isActive: true } }),
  ]);
  return getTagTemplate(ctx, id);
}

// ───────────── All Stock Summary ─────────────

type CardSpec = { asset: 'MONEY' | 'GOLD' | 'SILVER'; metalForm: 'USUAL' | 'KACHA' | null };
const CARDS: Record<SetStockCard, CardSpec> = {
  SHOP_CASH: { asset: 'MONEY', metalForm: null },
  FINE_GOLD: { asset: 'GOLD', metalForm: 'USUAL' },
  FINE_SILVER: { asset: 'SILVER', metalForm: 'USUAL' },
  KACCHA_GOLD: { asset: 'GOLD', metalForm: 'KACHA' },
  KACCHA_SILVER: { asset: 'SILVER', metalForm: 'KACHA' },
};

type Queryer = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Fine metal in every form except KACHA (stock rows, USUAL loose fine, BULLION) — kacha has its own card. */
async function fineBalance(client: Queryer, businessId: number, branches: number[], metal: 'GOLD' | 'SILVER'): Promise<Prisma.Decimal> {
  const rows = await client.$queryRaw<{ bal: Prisma.Decimal }[]>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN fine ELSE -fine END), 0)::numeric AS bal
    FROM "LedgerEntry"
    WHERE "businessId" = ${businessId} AND "branchId" IN (${Prisma.join(branches)}) AND asset::text = ${metal}
      AND ("metalForm" IS NULL OR "metalForm"::text <> 'KACHA')`);
  return D(rows[0]?.bal);
}

/** Shop cash = MONEY rows with no bank account (same as the dashboard's cash in hand). */
async function cashBalance(client: Queryer, businessId: number, branches: number[]): Promise<Prisma.Decimal> {
  const rows = await client.$queryRaw<{ bal: Prisma.Decimal }[]>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0)::numeric AS bal
    FROM "LedgerEntry"
    WHERE "businessId" = ${businessId} AND "branchId" IN (${Prisma.join(branches)}) AND asset::text = 'MONEY' AND "bankAccountId" IS NULL`);
  return D(rows[0]?.bal);
}

async function kachaTotal(client: Queryer, branches: number[], metal: 'GOLD' | 'SILVER'): Promise<Prisma.Decimal> {
  let sum = new Prisma.Decimal(0);
  for (const b of branches) sum = sum.plus((await kachaBalance(client, b, metal)).kacha);
  return sum;
}

async function cardBalance(client: Queryer, businessId: number, branches: number[], card: SetStockCard): Promise<Prisma.Decimal> {
  const spec = CARDS[card];
  if (spec.asset === 'MONEY') return cashBalance(client, businessId, branches);
  return spec.metalForm === 'KACHA' ? kachaTotal(client, branches, spec.asset) : fineBalance(client, businessId, branches, spec.asset);
}

/** Today's sell rate of the highest karat (max touch), per gram. null when no rate is set. */
function ratePerGram(m: { rateUnit: keyof typeof RATE_UNIT_GRAMS; rows: { touch: string; sellRate: string }[] }): Prisma.Decimal | null {
  const top = [...m.rows].sort((a, b) => Number(b.touch || 0) - Number(a.touch || 0) || Number(b.sellRate) - Number(a.sellRate))[0];
  return top ? D(top.sellRate).div(RATE_UNIT_GRAMS[m.rateUnit]) : null;
}

/** Girvi pledged metal by category name. shortcut: categories are free text ('Gold', 'Silver' by default), matched by substring; add a metal column to GirviItem if shops use other names. */
async function girviSummary(ctx: TenantContext, branches: number[]): Promise<AllStockSummaryDto['girvi']> {
  const [agg, metal] = await Promise.all([
    scopedDb(ctx).girviBatch.aggregate({ where: { status: 'ACTIVE', branchId: { in: branches } }, _count: { _all: true }, _sum: { principal: true } }),
    prisma.$queryRaw<{ m: string; fine: Prisma.Decimal }[]>(Prisma.sql`
      SELECT CASE WHEN i.category ILIKE '%silver%' THEN 'SILVER' WHEN i.category ILIKE '%gold%' THEN 'GOLD' ELSE 'OTHER' END AS m, COALESCE(SUM(i.fine), 0)::numeric AS fine
      FROM "GirviItem" i JOIN "GirviBatch" b ON b.id = i."batchId"
      WHERE b."businessId" = ${ctx.businessId!} AND b."branchId" IN (${Prisma.join(branches)}) AND b.status::text = 'ACTIVE' AND i.status::text = 'PLEDGED'
      GROUP BY 1`),
  ]);
  const of = (m: string) => wt(D(metal.find((r) => r.m === m)?.fine));
  return { activeCount: agg._count._all, principal: money(D(agg._sum.principal)), gold: of('GOLD'), silver: of('SILVER') };
}

export async function allStockSummary(ctx: TenantContext): Promise<AllStockSummaryDto> {
  const branches = branchFilter(ctx);
  const bId = ctx.businessId!;
  // Udhari + cash/bank come from the dashboard's own aggregates so both screens always agree.
  const [fineGold, fineSilver, kacchaGold, kacchaSilver, girvi, dash, rates] = await Promise.all([
    fineBalance(prisma, bId, branches, 'GOLD'),
    fineBalance(prisma, bId, branches, 'SILVER'),
    kachaTotal(prisma, branches, 'GOLD'),
    kachaTotal(prisma, branches, 'SILVER'),
    girviSummary(ctx, branches),
    dashboard(ctx),
    currentRates(ctx),
  ]);
  const goldRate = ratePerGram(rates.gold);
  const silverRate = ratePerGram(rates.silver);
  /*
   * totalAmount = (fineGold + kacchaGold + udhari.gold) × goldRatePerGram
   *             + (fineSilver + kacchaSilver + udhari.silver) × silverRatePerGram
   *             + shopCash + bank + udhari.amount + girvi.principal
   * Rate = today's sell rate of the highest karat (by touch) ÷ its rate-unit grams. No rate set → that metal counts as 0.
   * Girvi pledged metal is the customer's, so only the loan principal counts.
   */
  const goldFine = fineGold.plus(kacchaGold).plus(D(dash.udhari.gold));
  const silverFine = fineSilver.plus(kacchaSilver).plus(D(dash.udhari.silver));
  const total = goldFine.times(goldRate ?? 0)
    .plus(silverFine.times(silverRate ?? 0))
    .plus(D(dash.cash.inHand))
    .plus(D(dash.cash.bank))
    .plus(D(dash.udhari.amount))
    .plus(D(girvi.principal));
  return {
    fineGold: wt(fineGold),
    fineSilver: wt(fineSilver),
    kacchaGold: wt(kacchaGold),
    kacchaSilver: wt(kacchaSilver),
    girvi,
    udhari: { amount: dash.udhari.amount, gold: dash.udhari.gold, silver: dash.udhari.silver },
    shopCash: dash.cash.inHand,
    bank: dash.cash.bank,
    totalAmount: money(total),
    goldRatePerGram: goldRate ? money(goldRate) : null,
    silverRatePerGram: silverRate ? money(silverRate) : null,
  };
}

// ───────────── Set Stock (MPIN at the route) ─────────────

const CARD_LABEL: Record<SetStockCard, string> = { SHOP_CASH: 'Shop cash', FINE_GOLD: 'Fine gold', FINE_SILVER: 'Fine silver', KACCHA_GOLD: 'Kaccha gold', KACCHA_SILVER: 'Kaccha silver' };

/**
 * Sets one card's balance at the active branch: posts ONE SET_STOCK ledger row for the difference
 * (IN when raising, OUT when lowering) and writes a SetStockLog row. No change → log only, no ledger row.
 */
export async function setStock(ctx: TenantContext, body: z.output<typeof setStockBody>): Promise<SetStockLogDto> {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch to set stock (set X-Branch-Id)');
  const branchId = ctx.activeBranchId;
  const spec = CARDS[body.card];
  const isMoney = spec.asset === 'MONEY';
  const lctx = { businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId };
  const log = await prisma.$transaction(async (tx) => {
    // Serialize concurrent sets on the same branch so the difference is computed from a stable balance.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${branchId}::int4, 97::int4)`);
    const old = await cardBalance(tx, ctx.businessId!, [branchId], body.card);
    const next = new Prisma.Decimal(body.newBalance).toDecimalPlaces(isMoney ? 2 : 3);
    const diff = next.minus(old);
    const row = await tx.setStockLog.create({ data: { businessId: ctx.businessId!, branchId, card: body.card, oldBalance: old, newBalance: next, remarks: body.remarks ?? null, userId: ctx.userId } });
    if (!diff.isZero()) {
      const qty = diff.abs().toFixed(isMoney ? 2 : 3);
      await ledger.post(tx, lctx, [{
        branchId,
        asset: spec.asset,
        direction: diff.isPositive() ? 'IN' : 'OUT',
        metalForm: spec.metalForm,
        ...(isMoney ? { amount: qty } : { gross: qty, net: qty, fine: qty }),
        source: 'SET_STOCK',
        sourceId: String(row.id),
        narration: `Set ${CARD_LABEL[body.card].toLowerCase()} to ${next.toString()}${body.remarks ? ` · ${body.remarks}` : ''}`,
      }]);
    }
    await logActivity(tx, ctx, { module: 'SET_STOCK', action: 'EDITED', entity: 'SetStockLog', entityId: String(row.id), summary: `${CARD_LABEL[body.card]} set from ${old.toString()} to ${next.toString()}` });
    return row;
  });
  return (await logDtos(ctx, [log]))[0]!;
}

type LogRow = SetStockLog;
async function logDtos(ctx: TenantContext, rows: LogRow[]): Promise<SetStockLogDto[]> {
  const brIds = [...new Set(rows.map((r) => r.branchId))];
  const uIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x != null))];
  const [branches, users] = await Promise.all([
    brIds.length ? prisma.branch.findMany({ where: { id: { in: brIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
    uIds.length ? prisma.user.findMany({ where: { id: { in: uIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const br = new Map(branches.map((b) => [b.id, b.name]));
  const us = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    card: r.card as SetStockCard,
    branch: { id: r.branchId, name: br.get(r.branchId) ?? '' },
    oldBalance: r.oldBalance.toString(),
    newBalance: r.newBalance.toString(),
    difference: r.newBalance.minus(r.oldBalance).toString(),
    remarks: r.remarks,
    user: r.userId != null ? (us.get(r.userId) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listSetStockLogs(ctx: TenantContext, query: { page: number; pageSize: number; card?: SetStockCard }): Promise<Paged<SetStockLogDto>> {
  const where = { businessId: ctx.businessId!, branchId: { in: branchFilter(ctx) }, ...(query.card ? { card: query.card } : {}) };
  const [rows, total] = await Promise.all([
    prisma.setStockLog.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.setStockLog.count({ where }),
  ]);
  return { items: await logDtos(ctx, rows), total, page: query.page, pageSize: query.pageSize };
}


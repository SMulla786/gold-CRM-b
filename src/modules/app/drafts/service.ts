import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import { computeLine, RATE_UNIT_GRAMS } from '../../../shared';
import type { SalesDraftDto } from '../../../shared';
import { currentRates, getSettings } from '../service';
import { z } from 'zod';
import { salesDraftBody, draftDecisionBody, draftListQuery } from '../../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

type DraftBody = z.infer<typeof salesDraftBody>;
type Decision = z.infer<typeof draftDecisionBody>;
type ListQuery = z.infer<typeof draftListQuery>;

const money = (d: unknown) => new Prisma.Decimal((d as Prisma.Decimal.Value) ?? 0).toFixed(2);
const wt = (d: unknown) => new Prisma.Decimal((d as Prisma.Decimal.Value) ?? 0).toFixed(3);

/** Drafts belong to one branch — admins must pick one via X-Branch-Id. */
function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Next IST midnight: a draft made any time today expires at the end of today (Asia/Kolkata). */
function endOfToday(now = new Date()): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
  // IST = UTC+5:30, so the start of the next IST day in UTC is this IST date's UTC-midnight + 18.5h
  return new Date(Date.UTC(y!, m! - 1, d!) + 18.5 * 3600_000);
}

/** PENDING/APPROVED past its expiry reads as EXPIRED (never stored). */
function derivedStatus(status: string, expiresAt: Date, now = new Date()): SalesDraftDto['status'] {
  return (status === 'PENDING' || status === 'APPROVED') && now >= expiresAt ? 'EXPIRED' : (status as SalesDraftDto['status']);
}

/** Σ of each stock item's sell-line total at today's rates (display-only estimate; the bill recomputes). */
async function estimate(ctx: TenantContext, items: any[]): Promise<Prisma.Decimal> {
  const s = await getSettings(ctx);
  const rates = await currentRates(ctx);
  const basis = s['calc.basis'].sale;
  const rateFor = (cls: string, karatCode: string | null): { rate: number; unitGrams: number } => {
    const m = cls === 'GOLD' ? rates.gold : cls === 'SILVER' ? rates.silver : null;
    if (!m) return { rate: 0, unitGrams: 1 };
    const row = m.rows.find((r) => r.karatCode === karatCode);
    return { rate: Number(row?.sellRate ?? 0), unitGrams: RATE_UNIT_GRAMS[m.rateUnit] };
  };
  return items.reduce((sum, it) => {
    const { rate, unitGrams } = rateFor(it.stockClass, it.karatCode);
    const line = computeLine({ gross: Number(it.gross), less: Number(it.less), tunch: Number(it.tunch), wastage: Number(it.wastage), stoneCharge: Number(it.stoneCharge), labour: Number(it.labour), labourUnit: it.labourUnit, rate, rateUnitGrams: unitGrams, basis });
    return sum.plus(line.total);
  }, new Prisma.Decimal(0));
}

export async function createDraft(ctx: TenantContext, body: DraftBody): Promise<SalesDraftDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  if (body.partyId != null && !(await sdb.party.findUnique({ where: { id: body.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');

  // every item must be AVAILABLE in this branch right now (items are NOT reserved — billing re-checks)
  const ids = [...new Set(body.stockItemIds)];
  const items = await sdb.stockItem.findMany({ where: { id: { in: ids }, branchId, status: 'AVAILABLE' }, include: { itemName: true } });
  if (items.length !== ids.length) throw new HttpError(409, 'CONFLICT', 'Some items are not available in this branch');

  const estTotal = await estimate(ctx, items);
  const expiresAt = endOfToday();

  const draft = await prisma.$transaction(async (tx) => {
    const seq = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, 'DRAFT', 2)
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const draftNo = seq[0]!.next - 1; // series starts at 1
    const created = await tx.salesDraft.create({
      data: {
        businessId: ctx.businessId!, branchId, draftNo, createdById: ctx.userId!,
        partyId: body.partyId ?? null, customerName: body.customerName ?? '', mobile: body.mobile ?? null,
        estTotal, requestedDiscount: body.requestedDiscount, requestedDiscountUnit: body.requestedDiscountUnit,
        note: body.note ?? null, expiresAt,
        items: { create: ids.map((stockItemId) => ({ stockItemId })) },
      },
    });
    await logActivity(tx, ctx, { module: 'SALES_DRAFT', action: 'CREATED', entity: 'SALES_DRAFT', entityId: String(created.id), summary: `Draft #${created.draftNo} (${ids.length} item${ids.length === 1 ? '' : 's'})` });
    return created;
  });
  return (await buildDtos(ctx, [draft.id]))[0]!;
}

export async function listDrafts(ctx: TenantContext, query: ListQuery): Promise<{ items: SalesDraftDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  const now = new Date();
  // EXPIRED is derived: query the stored PENDING/APPROVED rows already past expiry,
  // and keep those expired rows out of a PENDING/APPROVED filter (an expired card can't be approved: 409).
  const byStatus = query.status === 'EXPIRED' ? { status: { in: ['PENDING', 'APPROVED'] as any }, expiresAt: { lt: now } }
    : query.status === 'PENDING' || query.status === 'APPROVED' ? { status: query.status as any, expiresAt: { gte: now } }
    : query.status ? { status: query.status as any } : {};
  // keyword: draft no., walk-in name/mobile, linked party name/mobile, note
  const kw = query.q;
  const draftNo = kw && /^\d+$/.test(kw) ? Number(kw) : undefined;
  const kwParties = kw ? (await sdb.party.findMany({ where: { OR: [{ name: { contains: kw, mode: 'insensitive' } }, { mobile: { contains: kw } }] }, select: { id: true } })).map((p) => p.id) : [];
  const where = kw ? { ...byStatus, OR: [
    ...(draftNo ? [{ draftNo }] : []),
    { customerName: { contains: kw, mode: 'insensitive' as const } },
    { mobile: { contains: kw } },
    { note: { contains: kw, mode: 'insensitive' as const } },
    { partyId: { in: kwParties } },
  ] } : byStatus;
  const [rows, total] = await Promise.all([
    sdb.salesDraft.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: { id: true } }),
    sdb.salesDraft.count({ where }),
  ]);
  return { items: await buildDtos(ctx, rows.map((r) => r.id)), total, page: query.page, pageSize: query.pageSize };
}

export async function getDraft(ctx: TenantContext, id: number): Promise<SalesDraftDto> {
  const [dto] = await buildDtos(ctx, [id]);
  if (!dto) throw new HttpError(404, 'NOT_FOUND', 'Draft not found');
  return dto;
}

/** Cashier retrieval on the Sell Bill: only an APPROVED, unexpired draft in the active branch can be billed. */
export async function getDraftByNo(ctx: TenantContext, draftNo: number): Promise<SalesDraftDto> {
  const branchId = activeBranch(ctx);
  const row = await scopedDb(ctx).salesDraft.findFirst({ where: { draftNo, branchId }, select: { id: true } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Draft not found');
  const dto = (await buildDtos(ctx, [row.id]))[0]!;
  if (dto.status !== 'APPROVED') throw new HttpError(409, 'CONFLICT', dto.status === 'EXPIRED' ? 'Draft has expired' : `Draft is ${dto.status.toLowerCase()}, not approved`);
  return dto;
}

export async function decideDraft(ctx: TenantContext, id: number, body: Decision): Promise<SalesDraftDto> {
  const sdb = scopedDb(ctx);
  const draft = await sdb.salesDraft.findUnique({ where: { id } });
  if (!draft) throw new HttpError(404, 'NOT_FOUND', 'Draft not found');
  if (derivedStatus(draft.status, draft.expiresAt) !== 'PENDING') throw new HttpError(409, 'CONFLICT', 'Only a pending draft can be approved or rejected');
  const data = body.decision === 'APPROVE'
    ? { status: 'APPROVED' as const, approvedDiscount: body.approvedDiscount, approvedDiscountUnit: body.approvedDiscountUnit, decidedById: ctx.userId!, decidedAt: new Date() }
    : { status: 'REJECTED' as const, rejectionReason: body.rejectionReason, decidedById: ctx.userId!, decidedAt: new Date() };
  await sdb.salesDraft.update({ where: { id }, data });
  await prisma.$transaction((tx) => logActivity(tx, ctx, { module: 'SALES_DRAFT', action: 'EDITED', entity: 'SALES_DRAFT', entityId: String(id), summary: `Draft #${draft.draftNo} ${body.decision === 'APPROVE' ? 'approved' : 'rejected'}` }));
  return (await buildDtos(ctx, [id]))[0]!;
}

export async function cancelDraft(ctx: TenantContext, id: number): Promise<SalesDraftDto> {
  const sdb = scopedDb(ctx);
  const draft = await sdb.salesDraft.findUnique({ where: { id } });
  if (!draft) throw new HttpError(404, 'NOT_FOUND', 'Draft not found');
  if (draft.status !== 'PENDING' && draft.status !== 'APPROVED') throw new HttpError(409, 'CONFLICT', `A ${draft.status.toLowerCase()} draft cannot be cancelled`);
  await sdb.salesDraft.update({ where: { id }, data: { status: 'CANCELLED' } });
  await prisma.$transaction((tx) => logActivity(tx, ctx, { module: 'SALES_DRAFT', action: 'DELETED', entity: 'SALES_DRAFT', entityId: String(id), summary: `Draft #${draft.draftNo} cancelled` }));
  return (await buildDtos(ctx, [id]))[0]!;
}

/** Hard-delete a draft that never became a bill (any status but BILLED); items cascade. */
export async function deleteDraft(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const draft = await sdb.salesDraft.findUnique({ where: { id } });
  if (!draft) throw new HttpError(404, 'NOT_FOUND', 'Draft not found');
  if (draft.status === 'BILLED' || draft.billId != null) throw new HttpError(409, 'CONFLICT', 'A billed draft cannot be deleted');
  await sdb.salesDraft.delete({ where: { id } });
  await prisma.$transaction((tx) => logActivity(tx, ctx, { module: 'SALES_DRAFT', action: 'DELETED', entity: 'SALES_DRAFT', entityId: String(id), summary: `Draft #${draft.draftNo} deleted` }));
}

// ───────────── builder ─────────────

async function buildDtos(ctx: TenantContext, ids: number[]): Promise<SalesDraftDto[]> {
  if (ids.length === 0) return [];
  const sdb = scopedDb(ctx);
  const drafts = await sdb.salesDraft.findMany({ where: { id: { in: ids } }, include: { items: true } });
  if (drafts.length === 0) return [];
  const now = new Date();

  const stockIds = [...new Set(drafts.flatMap((d) => d.items.map((i) => i.stockItemId)))];
  const partyIds = [...new Set(drafts.map((d) => d.partyId).filter((x): x is number => x != null))];
  const userIds = [...new Set(drafts.flatMap((d) => [d.createdById, d.decidedById]).filter((x): x is number => x != null))];
  const [stock, parties, users] = await Promise.all([
    stockIds.length ? sdb.stockItem.findMany({ where: { id: { in: stockIds } }, include: { itemName: true } }) : [],
    partyIds.length ? sdb.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const stockMap = new Map(stock.map((s) => [s.id, s]));
  const partyMap = new Map(parties.map((p) => [p.id, p]));
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const byId = new Map(drafts.map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter((d): d is NonNullable<typeof d> => !!d).map((d) => {
    const party = d.partyId != null ? partyMap.get(d.partyId) : null;
    return {
      id: d.id,
      draftNo: d.draftNo,
      createdAt: d.createdAt.toISOString(),
      salesman: { id: d.createdById, name: userMap.get(d.createdById) ?? '' },
      party: party ? { id: party.id, name: party.name, type: party.type, mobile: party.mobile, shopName: party.shopName } : null,
      customerName: d.customerName,
      mobile: d.mobile,
      items: d.items.map((it) => {
        const s = stockMap.get(it.stockItemId);
        return { stockItemId: it.stockItemId, label: s?.itemName?.name ?? `#${it.stockItemId}`, tagNo: s?.tagNo ?? null, gross: wt(s?.gross), available: s?.status === 'AVAILABLE' };
      }),
      estTotal: money(d.estTotal),
      requestedDiscount: money(d.requestedDiscount),
      requestedDiscountUnit: d.requestedDiscountUnit,
      approvedDiscount: d.approvedDiscount != null ? money(d.approvedDiscount) : null,
      approvedDiscountUnit: d.approvedDiscountUnit,
      note: d.note,
      status: derivedStatus(d.status, d.expiresAt, now),
      rejectionReason: d.rejectionReason,
      decidedBy: d.decidedById != null ? (userMap.get(d.decidedById) ?? null) : null,
      decidedAt: d.decidedAt?.toISOString() ?? null,
      billId: d.billId,
      expiresAt: d.expiresAt.toISOString(),
    };
  });
}

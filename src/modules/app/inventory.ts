import { rm } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import * as ledger from '../../lib/ledger';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { computeLine, stockRowInput } from '../../shared';
import { stockImagePath } from './uploads';
import type {
  BulkResultDto,
  GroupStockDto,
  ItemGroupDto,
  ItemNameDto,
  JewelleryTypeDto,
  Paged,
  ShortageRowDto,
  StockClass,
  StockEntryResultDto,
  StockImportResultDto,
  StockItemDto,
  StockSummaryDto,
  StockTransferDetailDto,
  StockTransferDto,
} from '../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (d: unknown): string => String(d);
const numN = (d: unknown): number => Number(d);

// ───────────── Jewellery types (global + custom; nullable businessId → scoped in-service) ─────────────

export async function listJewelleryTypes(ctx: TenantContext, stockClass?: StockClass): Promise<JewelleryTypeDto[]> {
  const rows = await prisma.jewelleryType.findMany({
    where: { isActive: true, OR: [{ businessId: null }, { businessId: ctx.businessId! }], ...(stockClass ? { stockClass } : {}) },
    orderBy: [{ businessId: 'asc' }, { name: 'asc' }],
  });
  return rows.map((t) => ({ id: t.id, name: t.name, stockClass: t.stockClass, isCustom: t.businessId != null }));
}

export async function createJewelleryType(ctx: TenantContext, body: { name: string; stockClass?: StockClass }): Promise<JewelleryTypeDto> {
  const t = await prisma.jewelleryType.create({ data: { businessId: ctx.businessId!, name: body.name, stockClass: body.stockClass ?? null } });
  return { id: t.id, name: t.name, stockClass: t.stockClass, isCustom: true };
}

// ───────────── Item groups ─────────────

const groupDto = (g: any): ItemGroupDto => ({
  id: g.id,
  stockClass: g.stockClass,
  name: g.name,
  jewelleryType: g.jewelleryType ? { id: g.jewelleryType.id, name: g.jewelleryType.name } : null,
  hsn: g.hsn ? { id: g.hsn.id, code: g.hsn.code } : null,
  gstRate: num(g.gstRate),
  minWeight: g.minWeight != null ? num(g.minWeight) : null,
  maxWeight: g.maxWeight != null ? num(g.maxWeight) : null,
  minPcs: g.minPcs,
  maxPcs: g.maxPcs,
  itemCount: g._count?.items ?? 0,
  isActive: g.isActive,
});

/** ItemGroup has no `hsn` relation; resolve HSN codes for a page of groups. */
async function hsnCodeMap(ids: (number | null)[]): Promise<Map<number, { id: number; code: string }>> {
  const uniq = [...new Set(ids.filter((x): x is number => x != null))];
  if (!uniq.length) return new Map();
  const rows = await prisma.hsnCode.findMany({ where: { id: { in: uniq } }, select: { id: true, code: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function listItemGroups(ctx: TenantContext, query: { page: number; pageSize: number; q?: string; stockClass?: StockClass; jewelleryTypeId?: number }): Promise<Paged<ItemGroupDto>> {
  const sdb = scopedDb(ctx);
  const where = {
    ...(query.stockClass ? { stockClass: query.stockClass } : {}),
    ...(query.jewelleryTypeId ? { jewelleryTypeId: query.jewelleryTypeId } : {}),
    ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.itemGroup.findMany({ where, include: { jewelleryType: true, _count: { select: { items: true } } }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { name: 'asc' } }),
    sdb.itemGroup.count({ where }),
  ]);
  const hsn = await hsnCodeMap(rows.map((r) => r.hsnId));
  return { items: rows.map((g) => groupDto({ ...g, hsn: g.hsnId != null ? hsn.get(g.hsnId) : null })), total, page: query.page, pageSize: query.pageSize };
}

export async function createItemGroups(ctx: TenantContext, body: { stockClass: StockClass; jewelleryTypeId?: number; names: string[]; hsnId?: number; gstRate: number; minWeight?: number; maxWeight?: number; minPcs?: number; maxPcs?: number }): Promise<ItemGroupDto[]> {
  const sdb = scopedDb(ctx);
  if (body.jewelleryTypeId != null) {
    const jt = await prisma.jewelleryType.findFirst({ where: { id: body.jewelleryTypeId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } });
    if (!jt) throw new HttpError(404, 'NOT_FOUND', 'Jewellery type not found');
  }
  if (body.hsnId != null && !(await prisma.hsnCode.findUnique({ where: { id: body.hsnId } }))) throw new HttpError(404, 'NOT_FOUND', 'HSN not found');
  const out: ItemGroupDto[] = [];
  for (const name of body.names) {
    const g = await sdb.itemGroup.create({
      data: { stockClass: body.stockClass, jewelleryTypeId: body.jewelleryTypeId ?? null, name, hsnId: body.hsnId ?? null, gstRate: body.gstRate, minWeight: body.minWeight ?? null, maxWeight: body.maxWeight ?? null, minPcs: body.minPcs ?? null, maxPcs: body.maxPcs ?? null } as never,
      include: { jewelleryType: true, _count: { select: { items: true } } },
    });
    const hsn = await hsnCodeMap([g.hsnId]);
    out.push(groupDto({ ...g, hsn: g.hsnId != null ? hsn.get(g.hsnId) : null }));
  }
  return out;
}

export async function updateItemGroup(ctx: TenantContext, groupId: number, body: Record<string, any>): Promise<ItemGroupDto> {
  if (body.hsnId != null && !(await prisma.hsnCode.findUnique({ where: { id: body.hsnId } }))) throw new HttpError(404, 'NOT_FOUND', 'HSN not found');
  if (body.jewelleryTypeId != null && !(await prisma.jewelleryType.findFirst({ where: { id: body.jewelleryTypeId, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } }))) throw new HttpError(404, 'NOT_FOUND', 'Jewellery type not found');
  const g = await scopedDb(ctx).itemGroup.update({ where: { id: groupId }, data: body, include: { jewelleryType: true, _count: { select: { items: true } } } });
  const hsn = await hsnCodeMap([g.hsnId]);
  return groupDto({ ...g, hsn: g.hsnId != null ? hsn.get(g.hsnId) : null });
}

// ───────────── Item names ─────────────

const itemNameDto = (n: any, hsn: { id: number; code: string } | null): ItemNameDto => ({
  id: n.id,
  name: n.name,
  group: { id: n.group.id, name: n.group.name, stockClass: n.group.stockClass },
  hsn,
  taxValue: n.taxValue != null ? num(n.taxValue) : null,
  taxUnit: n.taxUnit,
  method: n.method,
  tagPrefix: n.tagPrefix,
  tagDigits: n.tagDigits,
  minWeight: n.minWeight != null ? num(n.minWeight) : null,
  maxWeight: n.maxWeight != null ? num(n.maxWeight) : null,
  minPcs: n.minPcs,
  maxPcs: n.maxPcs,
  defKaratCode: n.defKaratCode,
  defTunch: n.defTunch != null ? num(n.defTunch) : null,
  defWastage: n.defWastage != null ? num(n.defWastage) : null,
  defLabour: n.defLabour != null ? num(n.defLabour) : null,
  defLabourUnit: n.defLabourUnit,
  isActive: n.isActive,
});

export async function listItemNames(ctx: TenantContext, query: { page: number; pageSize: number; q?: string; stockClass?: StockClass; groupId?: number }): Promise<Paged<ItemNameDto>> {
  const sdb = scopedDb(ctx);
  const where = {
    ...(query.groupId ? { groupId: query.groupId } : {}),
    ...(query.stockClass ? { group: { stockClass: query.stockClass } } : {}),
    ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.itemName.findMany({ where, include: { group: true }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { name: 'asc' } }),
    sdb.itemName.count({ where }),
  ]);
  const hsn = await hsnCodeMap(rows.map((r) => r.hsnId));
  return { items: rows.map((n) => itemNameDto(n, n.hsnId != null ? (hsn.get(n.hsnId) ?? null) : null)), total, page: query.page, pageSize: query.pageSize };
}

export async function createItemName(ctx: TenantContext, body: Record<string, any>): Promise<ItemNameDto> {
  const sdb = scopedDb(ctx);
  const group = await sdb.itemGroup.findUnique({ where: { id: body.groupId } });
  if (!group) throw new HttpError(404, 'NOT_FOUND', 'Item group not found');
  if ((body.method === 'TAG' || body.method === 'BOTH') && (!body.tagPrefix || !body.tagDigits)) {
    throw new HttpError(400, 'VALIDATION', 'TAG/BOTH item names need tagPrefix and tagDigits');
  }
  if (body.hsnId != null && !(await prisma.hsnCode.findUnique({ where: { id: body.hsnId } }))) throw new HttpError(404, 'NOT_FOUND', 'HSN not found');
  const n = await sdb.itemName.create({ data: body as never, include: { group: true } });
  const hsn = await hsnCodeMap([n.hsnId]);
  return itemNameDto(n, n.hsnId != null ? (hsn.get(n.hsnId) ?? null) : null);
}

export async function updateItemName(ctx: TenantContext, itemNameId: number, body: Record<string, any>): Promise<ItemNameDto> {
  if (body.hsnId != null && !(await prisma.hsnCode.findUnique({ where: { id: body.hsnId } }))) throw new HttpError(404, 'NOT_FOUND', 'HSN not found');
  if (body.groupId != null && !(await scopedDb(ctx).itemGroup.findUnique({ where: { id: body.groupId } }))) throw new HttpError(404, 'NOT_FOUND', 'Item group not found');
  const n = await scopedDb(ctx).itemName.update({ where: { id: itemNameId }, data: body, include: { group: true } });
  const hsn = await hsnCodeMap([n.hsnId]);
  return itemNameDto(n, n.hsnId != null ? (hsn.get(n.hsnId) ?? null) : null);
}

// ───────────── Stock mapper + helpers ─────────────

const stockDto = (s: any, branchName: string, hsnCode: string | null): StockItemDto => ({
  id: s.id,
  branch: { id: s.branchId, name: branchName },
  stockClass: s.stockClass,
  group: { id: s.group.id, name: s.group.name },
  itemName: { id: s.itemName.id, name: s.itemName.name },
  hsnCode,
  method: s.method,
  tagNo: s.tagNo,
  huid: s.huid,
  karatCode: s.karatCode,
  pcs: s.pcs,
  gross: num(s.gross),
  less: num(s.less),
  net: num(s.net),
  tunch: num(s.tunch),
  wastage: num(s.wastage),
  fine: num(s.fine),
  stoneCharge: num(s.stoneCharge),
  labour: num(s.labour),
  labourUnit: s.labourUnit,
  other: num(s.other),
  rate: s.rate != null ? num(s.rate) : null,
  purchaseCost: s.purchaseCost != null ? num(s.purchaseCost) : null,
  status: s.status,
  entryNo: s.entryNo,
  photoUrl: s.photoUrl,
  remarks: s.remarks,
  createdAt: s.createdAt.toISOString(),
});

async function decorateStock(ctx: TenantContext, items: any[]): Promise<StockItemDto[]> {
  const branchIds = [...new Set(items.map((i) => i.branchId))];
  const branches = branchIds.length ? await scopedDb(ctx).branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [];
  const brName = new Map(branches.map((b) => [b.id, b.name]));
  const hsn = await hsnCodeMap(items.flatMap((i) => [i.itemName.hsnId, i.group.hsnId]));
  return items.map((i) => {
    const code = i.itemName.hsnId != null ? hsn.get(i.itemName.hsnId)?.code : i.group.hsnId != null ? hsn.get(i.group.hsnId)?.code : null;
    return stockDto(i, brName.get(i.branchId) ?? '', code ?? null);
  });
}

/** Atomic per-(business,prefix) tag number. INSERT … ON CONFLICT … RETURNING is the lock-free increment. Exported so purchase bills reuse the same tag core. */
export async function nextTagNo(tx: Prisma.TransactionClient, businessId: number, prefix: string, digits: number): Promise<string> {
  const r = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "TagSequence" ("businessId", "prefix", "next") VALUES (${businessId}, ${prefix}, 2)
    ON CONFLICT ("businessId", "prefix") DO UPDATE SET "next" = "TagSequence"."next" + 1
    RETURNING "next"`;
  const used = Number(r[0]!.next) - 1;
  return `${prefix}${String(used).padStart(digits, '0')}`;
}

/** Race-free entry number via the same atomic TagSequence upsert (reserved prefix '#ENTRY'). */
async function nextEntryNo(tx: Prisma.TransactionClient, businessId: number): Promise<number> {
  const r = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "TagSequence" ("businessId", "prefix", "next") VALUES (${businessId}, '#ENTRY', 2)
    ON CONFLICT ("businessId", "prefix") DO UPDATE SET "next" = "TagSequence"."next" + 1
    RETURNING "next"`;
  return Number(r[0]!.next) - 1;
}

function resolveRow(row: any, itemName: any, touchByCode: Map<string, number>) {
  const karatCode = row.karatCode ?? itemName.defKaratCode ?? null;
  const tunch = row.tunch ?? (karatCode ? touchByCode.get(karatCode) : undefined) ?? 100;
  const line = computeLine({
    pcs: row.pcs, gross: row.gross, less: row.less, tunch, wastage: row.wastage,
    stoneCharge: row.stoneCharge, labour: row.labour, labourUnit: row.labourUnit, other: row.other,
    rate: row.rate, rateUnitGrams: 1, basis: 'NET',
  });
  // Keep string/number weights as-is (no Number() round-trip for money/weights).
  const purchaseCost: string | number | null = row.purchaseCost != null ? row.purchaseCost : row.rate != null ? line.total : null;
  return { karatCode, tunch, net: line.net, fine: line.fine, purchaseCost };
}

// ───────────── Stock entry ─────────────

export async function createStockEntry(ctx: TenantContext, body: { stockClass: StockClass; method: 'LOOSE' | 'TAG'; branchId?: number; txnDate?: Date; rows: any[] }): Promise<StockEntryResultDto> {
  const branchId = body.branchId ?? ctx.activeBranchId ?? ctx.scopeBranchId;
  if (branchId == null || !ctx.branchIds.includes(branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const sdb = scopedDb(ctx);

  // Resolve + validate every item name up-front (scoped).
  const nameIds = [...new Set(body.rows.map((r) => r.itemNameId))];
  const itemNames = await sdb.itemName.findMany({ where: { id: { in: nameIds } }, include: { group: true } });
  const byId = new Map(itemNames.map((n) => [n.id, n]));
  for (const r of body.rows) {
    const n = byId.get(r.itemNameId);
    if (!n) throw new HttpError(404, 'NOT_FOUND', `Item name ${r.itemNameId} not found`);
    if (n.group.stockClass !== body.stockClass) throw new HttpError(400, 'VALIDATION', 'Item name does not match stock class');
    if (n.method !== 'BOTH' && n.method !== body.method) throw new HttpError(400, 'VALIDATION', `Item "${n.name}" does not allow ${body.method}`);
    if (body.method === 'TAG' && !r.tagNo && (!n.tagPrefix || !n.tagDigits)) throw new HttpError(400, 'VALIDATION', `Item "${n.name}" has no tag prefix/digits for auto-tagging`);
  }
  const touchByCode = new Map((await sdb.karatMapping.findMany({ select: { code: true, touch: true } })).map((k) => [k.code, Number(k.touch)]));
  const lctx = { businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId };

  const createdIds = await prisma.$transaction(async (tx) => {
    const entryNo = await nextEntryNo(tx, ctx.businessId!);
    const ids: number[] = [];
    for (const row of body.rows) {
      const n = byId.get(row.itemNameId)!;
      const r = resolveRow(row, n, touchByCode);
      const tagNo = body.method === 'TAG' ? (row.tagNo ?? (await nextTagNo(tx, ctx.businessId!, n.tagPrefix!, n.tagDigits!))) : null;
      const pcs = body.method === 'TAG' ? (row.pcs ?? 1) : row.pcs;
      const item = await tx.stockItem.create({
        data: {
          businessId: ctx.businessId!, branchId, stockClass: body.stockClass, groupId: n.groupId, itemNameId: n.id, method: body.method,
          tagNo, huid: row.huid ?? null, karatCode: r.karatCode, pcs, gross: row.gross, less: row.less, net: r.net, tunch: r.tunch, wastage: row.wastage,
          fine: r.fine, stoneCharge: row.stoneCharge, labour: row.labour, labourUnit: row.labourUnit, other: row.other, rate: row.rate ?? null,
          purchaseCost: r.purchaseCost, status: 'AVAILABLE', source: 'STOCK_INSERT', sourceId: String(entryNo), entryNo, remarks: row.remarks ?? null, createdById: ctx.userId,
        },
      });
      await ledger.post(tx, lctx, [{
        branchId, txnDate: body.txnDate, asset: ledger.assetForStockClass(body.stockClass), direction: 'IN', karatCode: r.karatCode, pcs, gross: row.gross,
        net: r.net, fine: r.fine, amount: r.purchaseCost, source: 'STOCK_INSERT', sourceId: String(item.id), stockItemId: item.id, narration: `New stock entry #${entryNo}`,
      }]);
      ids.push(item.id);
    }
    await logActivity(tx, ctx, { module: 'STOCK', action: 'CREATED', entity: 'StockEntry', entityId: String(entryNo), summary: `Stock entry #${entryNo} (${ids.length} item(s))` });
    return ids;
  });

  const items = await scopedDb(ctx).stockItem.findMany({ where: { id: { in: createdIds } }, include: { group: true, itemName: true } });
  return { entryNo: items[0]?.entryNo ?? 0, items: await decorateStock(ctx, items) };
}

// ───────────── Stock list / get / by-tag / summary / groups ─────────────

/** Shared stockListQuery → where (item list + group-wise roll-up). q matches tag no, HUID or item name. */
function stockWhere(query: any): any {
  return {
    status: query.status,
    ...(query.stockClass ? { stockClass: query.stockClass } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.groupId ? { groupId: query.groupId } : {}),
    ...(query.itemNameId ? { itemNameId: query.itemNameId } : {}),
    ...(query.karatCode ? { karatCode: query.karatCode } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.q ? { OR: [{ tagNo: { contains: query.q, mode: 'insensitive' } }, { huid: { contains: query.q, mode: 'insensitive' } }, { itemName: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    ...(query.minWeight != null || query.maxWeight != null ? { net: { ...(query.minWeight != null ? { gte: query.minWeight } : {}), ...(query.maxWeight != null ? { lte: query.maxWeight } : {}) } } : {}),
  };
}

export async function listStock(ctx: TenantContext, query: any): Promise<Paged<StockItemDto>> {
  const sdb = scopedDb(ctx);
  const where = stockWhere(query);
  const [rows, total] = await Promise.all([
    sdb.stockItem.findMany({ where, include: { group: true, itemName: true }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { id: 'desc' } }),
    sdb.stockItem.count({ where }),
  ]);
  return { items: await decorateStock(ctx, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getStock(ctx: TenantContext, id: number): Promise<StockItemDto> {
  const item = await scopedDb(ctx).stockItem.findUnique({ where: { id }, include: { group: true, itemName: true } });
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'Stock item not found');
  return (await decorateStock(ctx, [item]))[0]!;
}

export async function getStockByTag(ctx: TenantContext, tagNo: string): Promise<StockItemDto> {
  const branchFilter = ctx.activeBranchId != null ? { branchId: ctx.activeBranchId } : {};
  const item = await scopedDb(ctx).stockItem.findFirst({ where: { tagNo: tagNo.toUpperCase(), status: 'AVAILABLE', ...branchFilter }, include: { group: true, itemName: true } });
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'Available item with that tag not found');
  return (await decorateStock(ctx, [item]))[0]!;
}

export async function stockSummary(ctx: TenantContext): Promise<StockSummaryDto[]> {
  const grouped = await scopedDb(ctx).stockItem.groupBy({ by: ['stockClass'], where: { status: 'AVAILABLE' }, _count: { _all: true }, _sum: { pcs: true, gross: true, net: true, fine: true, purchaseCost: true } });
  return grouped.map((g) => ({ stockClass: g.stockClass, items: g._count._all, pcs: g._sum.pcs ?? 0, gross: num(g._sum.gross ?? 0), net: num(g._sum.net ?? 0), fine: num(g._sum.fine ?? 0), value: num(g._sum.purchaseCost ?? 0) }));
}

export async function stockGroups(ctx: TenantContext, query: any): Promise<GroupStockDto[]> {
  const sdb = scopedDb(ctx);
  // Same filters as the item list; status comes from stockListQuery (defaults to AVAILABLE, the previous hard-coded value).
  const where = stockWhere({ ...query, status: query.status ?? 'AVAILABLE' });
  const grouped = await sdb.stockItem.groupBy({ by: ['groupId', 'karatCode'], where, _count: { _all: true }, _sum: { pcs: true, gross: true, net: true, fine: true, purchaseCost: true } });
  const groups = await sdb.itemGroup.findMany({ where: { id: { in: [...new Set(grouped.map((g) => g.groupId))] } } });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const hsn = await hsnCodeMap(groups.map((g) => g.hsnId));
  return grouped.map((g) => {
    const grp = byId.get(g.groupId);
    return { groupId: g.groupId, groupName: grp?.name ?? '', hsnCode: grp?.hsnId != null ? (hsn.get(grp.hsnId)?.code ?? null) : null, karatCode: g.karatCode, items: g._count._all, pcs: g._sum.pcs ?? 0, gross: num(g._sum.gross ?? 0), net: num(g._sum.net ?? 0), fine: num(g._sum.fine ?? 0), value: num(g._sum.purchaseCost ?? 0) };
  });
}

// ───────────── Stock edit / delete (with ledger reversal) ─────────────

const touchMap = async (sdb: any): Promise<Map<string, number>> => new Map((await sdb.karatMapping.findMany({ select: { code: true, touch: true } })).map((k: any) => [k.code, Number(k.touch)]));
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

/** Recompute one item, reverse ALL its ledger rows (any source, so a transferred item nets to 0 at both branches), repost the fresh IN at its current branch. */
async function applyStockEdit(tx: Prisma.TransactionClient, lctx: ledger.LedgerContext, item: any, body: any, touchByCode: Map<string, number>): Promise<void> {
  const merged = { pcs: item.pcs, gross: numN(item.gross), less: numN(item.less), tunch: numN(item.tunch), wastage: numN(item.wastage), stoneCharge: numN(item.stoneCharge), labour: numN(item.labour), labourUnit: item.labourUnit, other: numN(item.other), rate: item.rate != null ? numN(item.rate) : undefined, purchaseCost: item.purchaseCost != null ? numN(item.purchaseCost) : undefined, karatCode: item.karatCode ?? undefined, huid: item.huid ?? undefined, remarks: item.remarks ?? undefined, ...body };
  const r = resolveRow(merged, item.itemName, touchByCode);
  await tx.stockItem.update({ where: { id: item.id }, data: { pcs: merged.pcs, gross: merged.gross, less: merged.less, tunch: r.tunch, wastage: merged.wastage, net: r.net, fine: r.fine, stoneCharge: merged.stoneCharge, labour: merged.labour, labourUnit: merged.labourUnit, other: merged.other, rate: merged.rate ?? null, purchaseCost: r.purchaseCost, karatCode: r.karatCode, huid: merged.huid ?? null, remarks: merged.remarks ?? null } });
  await ledger.reverseForItem(tx, lctx, item.id);
  await ledger.post(tx, lctx, [{ branchId: item.branchId, asset: ledger.assetForStockClass(item.stockClass), direction: 'IN', karatCode: r.karatCode, pcs: merged.pcs, gross: merged.gross, net: r.net, fine: r.fine, amount: r.purchaseCost, source: 'STOCK_INSERT', sourceId: String(item.id), stockItemId: item.id, narration: `Edit stock item #${item.id}` }]);
}

/** A sold item can't be edited/deleted — but only while its SELL_BILL row is live. A bill deleted with stock return reverses that row, so the item is AVAILABLE again and must stay editable. */
async function assertNotSold(ctx: TenantContext, ids: number[]): Promise<void> {
  const sellRows = await prisma.ledgerEntry.findMany({ where: { businessId: ctx.businessId!, stockItemId: { in: ids }, source: 'SELL_BILL', reversalOfId: null }, select: { id: true, stockItemId: true } });
  if (sellRows.length === 0) return;
  const reversed = new Set((await prisma.ledgerEntry.findMany({ where: { businessId: ctx.businessId!, reversalOfId: { in: sellRows.map((r) => r.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId));
  const live = sellRows.find((r) => !reversed.has(r.id));
  if (live) throw new HttpError(409, 'CONFLICT', `Item #${live.stockItemId} is on a sell bill — correct it from the bill`);
}

/** Lock the ids inside the tx and confirm all are still AVAILABLE (count must equal n), else 409 — closes the edit-vs-transfer/delete race. */
async function lockAvailable(tx: Prisma.TransactionClient, ids: number[]): Promise<void> {
  const locked = await tx.stockItem.updateMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, data: { status: 'AVAILABLE' } });
  if (locked.count !== ids.length) throw new HttpError(409, 'CONFLICT', 'A stock item is not AVAILABLE or changed concurrently');
}

async function editStock(ctx: TenantContext, uniq: number[], patch: any): Promise<number> {
  const sdb = scopedDb(ctx);
  const items = await sdb.stockItem.findMany({ where: { id: { in: uniq } }, include: { itemName: true } });
  if (items.length !== uniq.length) throw new HttpError(404, 'NOT_FOUND', 'One or more stock items not found');
  for (const it of items) if (it.status !== 'AVAILABLE') throw new HttpError(409, 'CONFLICT', `Item #${it.id} is not AVAILABLE`);
  await assertNotSold(ctx, uniq);
  const touchByCode = await touchMap(sdb);
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    await lockAvailable(tx, uniq);
    for (const item of items) await applyStockEdit(tx, lctx, item, patch, touchByCode);
    await logActivity(tx, ctx, { module: 'STOCK', action: 'EDITED', entity: 'StockItem', entityId: uniq.join(','), summary: `Edited ${items.length} stock item(s)` });
  });
  return items.length;
}

async function deleteStockItems(ctx: TenantContext, uniq: number[]): Promise<number> {
  const sdb = scopedDb(ctx);
  const items = await sdb.stockItem.findMany({ where: { id: { in: uniq } } });
  if (items.length !== uniq.length) throw new HttpError(404, 'NOT_FOUND', 'One or more stock items not found');
  await assertNotSold(ctx, uniq);
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    const locked = await tx.stockItem.updateMany({ where: { id: { in: uniq }, status: 'AVAILABLE' }, data: { status: 'DELETED' } });
    if (locked.count !== uniq.length) throw new HttpError(409, 'CONFLICT', 'A stock item is not AVAILABLE or changed concurrently');
    for (const id of uniq) await ledger.reverseForItem(tx, lctx, id);
    await logActivity(tx, ctx, { module: 'STOCK', action: 'DELETED', entity: 'StockItem', entityId: uniq.join(','), summary: `Deleted ${uniq.length} stock item(s)` });
  });
  return uniq.length;
}

export async function updateStock(ctx: TenantContext, id: number, body: any): Promise<StockItemDto> {
  await editStock(ctx, [id], body);
  return getStock(ctx, id);
}

export async function deleteStock(ctx: TenantContext, id: number): Promise<void> {
  await deleteStockItems(ctx, [id]);
}

/** Clears a stock item's photo (scoped lookup) and deletes the stored file; no-op when it has none. */
export async function removeStockPhoto(ctx: TenantContext, id: number): Promise<void> {
  const item = await scopedDb(ctx).stockItem.findUnique({ where: { id } });
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'Stock item not found');
  if (!item.photoUrl) return;
  const abs = await stockImagePath(ctx, id).catch(() => null);
  await scopedDb(ctx).stockItem.update({ where: { id }, data: { photoUrl: null } });
  if (abs) await rm(abs, { force: true }).catch(() => {});
}

// ───────────── Bulk edit / delete (one tx, reuse the single-item path) ─────────────

export async function bulkEditStock(ctx: TenantContext, ids: number[], patch: any): Promise<BulkResultDto> {
  return { updated: await editStock(ctx, [...new Set(ids)], patch) };
}

export async function bulkDeleteStock(ctx: TenantContext, ids: number[]): Promise<BulkResultDto> {
  return { updated: await deleteStockItems(ctx, [...new Set(ids)]) };
}

// ───────────── Stock transfer (inter-branch move; both branches in subtree) ─────────────

/** Race-free per-business transfer number via the atomic TagSequence upsert (reserved prefix '#TRANSFER'). */
async function nextTransferNo(tx: Prisma.TransactionClient, businessId: number): Promise<number> {
  const r = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "TagSequence" ("businessId", "prefix", "next") VALUES (${businessId}, '#TRANSFER', 2)
    ON CONFLICT ("businessId", "prefix") DO UPDATE SET "next" = "TagSequence"."next" + 1
    RETURNING "next"`;
  return Number(r[0]!.next) - 1;
}

export async function createStockTransfer(ctx: TenantContext, body: { fromBranchId: number; toBranchId: number; stockItemIds: number[]; remarks?: string }): Promise<StockTransferDetailDto> {
  if (!ctx.branchIds.includes(body.fromBranchId) || !ctx.branchIds.includes(body.toBranchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const sdb = scopedDb(ctx);
  const uniq = [...new Set(body.stockItemIds)];
  const items = await sdb.stockItem.findMany({ where: { id: { in: uniq } } });
  if (items.length !== uniq.length) throw new HttpError(404, 'NOT_FOUND', 'One or more stock items not found');
  for (const it of items) {
    if (it.branchId !== body.fromBranchId) throw new HttpError(409, 'CONFLICT', `Item #${it.id} is not in the source branch`);
    if (it.status !== 'AVAILABLE') throw new HttpError(409, 'CONFLICT', `Item #${it.id} is not AVAILABLE`);
  }
  const txnDate = ledger.businessDate();
  const lctx = lctxOf(ctx);
  const header = await prisma.$transaction(async (tx) => {
    const transferNo = await nextTransferNo(tx, ctx.businessId!);
    const h = await tx.stockTransfer.create({ data: { businessId: ctx.businessId!, transferNo, fromBranchId: body.fromBranchId, toBranchId: body.toBranchId, txnDate, itemCount: items.length, remarks: body.remarks ?? null, createdById: ctx.userId } });
    // Move + race-guard in one write: only still-AVAILABLE items in the source branch move (stays AVAILABLE); count must match.
    const moved = await tx.stockItem.updateMany({ where: { id: { in: uniq }, branchId: body.fromBranchId, status: 'AVAILABLE' }, data: { branchId: body.toBranchId } });
    if (moved.count !== uniq.length) throw new HttpError(409, 'CONFLICT', 'A stock item is no longer AVAILABLE in the source branch');
    for (const it of items) {
      const common = { asset: ledger.assetForStockClass(it.stockClass), karatCode: it.karatCode, pcs: it.pcs, gross: it.gross, net: it.net, fine: it.fine, amount: it.purchaseCost, source: 'STOCK_TRANSFER' as const, sourceId: String(h.id), stockItemId: it.id };
      await ledger.post(tx, lctx, [
        { ...common, branchId: body.fromBranchId, direction: 'OUT', txnDate, narration: `Transfer #${transferNo} out` },
        { ...common, branchId: body.toBranchId, direction: 'IN', txnDate, narration: `Transfer #${transferNo} in` },
      ]);
    }
    await logActivity(tx, ctx, { module: 'STOCK_TRANSFER', action: 'CREATED', entity: 'StockTransfer', entityId: String(h.id), summary: `Transfer #${transferNo} (${items.length} item(s))` });
    return h;
  });
  return getStockTransfer(ctx, header.id);
}

/** Branch + creator display names within the business (a transfer's far end may sit outside the active subtree). */
async function transferNames(ctx: TenantContext, transfers: any[]): Promise<{ branch: Map<number, string>; user: Map<number, string> }> {
  const brIds = [...new Set(transfers.flatMap((t) => [t.fromBranchId, t.toBranchId]))];
  const uIds = [...new Set(transfers.map((t) => t.createdById).filter((x): x is number => x != null))];
  const [branches, users] = await Promise.all([
    brIds.length ? prisma.branch.findMany({ where: { id: { in: brIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
    uIds.length ? prisma.user.findMany({ where: { id: { in: uIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  return { branch: new Map(branches.map((b) => [b.id, b.name])), user: new Map(users.map((u) => [u.id, u.name])) };
}

const transferDto = (t: any, sums: { gross: unknown; fine: unknown } | undefined, names: { branch: Map<number, string>; user: Map<number, string> }): StockTransferDto => ({
  id: t.id,
  transferNo: t.transferNo,
  txnDate: t.txnDate.toISOString().slice(0, 10),
  fromBranch: { id: t.fromBranchId, name: names.branch.get(t.fromBranchId) ?? '' },
  toBranch: { id: t.toBranchId, name: names.branch.get(t.toBranchId) ?? '' },
  itemCount: t.itemCount,
  gross: num(sums?.gross ?? 0),
  fine: num(sums?.fine ?? 0),
  remarks: t.remarks,
  createdBy: t.createdById != null ? (names.user.get(t.createdById) ?? null) : null,
  createdAt: t.createdAt.toISOString(),
});

/** Σ gross/fine of the moved items per transfer, from the IN ledger rows. */
async function transferSums(ctx: TenantContext, ids: number[]): Promise<Map<string, { gross: unknown; fine: unknown }>> {
  if (!ids.length) return new Map();
  // reversalOfId: null — exclude reversal rows (a reversed OUT@from is itself an IN row and would double-count the moved weight).
  const agg = await prisma.ledgerEntry.groupBy({ by: ['sourceId'], where: { businessId: ctx.businessId!, source: 'STOCK_TRANSFER', direction: 'IN', reversalOfId: null, sourceId: { in: ids.map(String) } }, _sum: { gross: true, fine: true } });
  return new Map(agg.map((a) => [a.sourceId, { gross: a._sum.gross, fine: a._sum.fine }]));
}

export async function listStockTransfers(ctx: TenantContext, query: { page: number; pageSize: number; branchId?: number; from?: Date; to?: Date }): Promise<Paged<StockTransferDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(query.branchId ? { OR: [{ fromBranchId: query.branchId }, { toBranchId: query.branchId }] } : {}),
    ...(query.from || query.to ? { txnDate: { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.stockTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.stockTransfer.count({ where }),
  ]);
  const [names, sums] = await Promise.all([transferNames(ctx, rows), transferSums(ctx, rows.map((r) => r.id))]);
  return { items: rows.map((t) => transferDto(t, sums.get(String(t.id)), names)), total, page: query.page, pageSize: query.pageSize };
}

export async function getStockTransfer(ctx: TenantContext, id: number): Promise<StockTransferDetailDto> {
  const t = await scopedDb(ctx).stockTransfer.findFirst({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Transfer not found');
  const [names, sums] = await Promise.all([transferNames(ctx, [t]), transferSums(ctx, [t.id])]);
  const led = await prisma.ledgerEntry.findMany({ where: { businessId: ctx.businessId!, source: 'STOCK_TRANSFER', sourceId: String(id), direction: 'IN', reversalOfId: null }, select: { stockItemId: true } });
  const stockIds = [...new Set(led.map((r) => r.stockItemId).filter((x): x is number => x != null))];
  // Raw prisma: moved items now sit at toBranch, which may be outside the viewer's subtree when they only cover fromBranch.
  const items = stockIds.length ? await prisma.stockItem.findMany({ where: { id: { in: stockIds }, businessId: ctx.businessId! }, include: { group: true, itemName: true } }) : [];
  return { ...transferDto(t, sums.get(String(t.id)), names), items: await decorateStock(ctx, items) };
}

// ───────────── Shortage ─────────────

export async function shortage(ctx: TenantContext, query: { stockClass?: StockClass; jewelleryTypeId?: number; status?: 'SHORTAGE' | 'WARNING' | 'OK'; q?: string }): Promise<ShortageRowDto[]> {
  const sdb = scopedDb(ctx);
  const groups = await sdb.itemGroup.findMany({
    where: { isActive: true, ...(query.stockClass ? { stockClass: query.stockClass } : {}), ...(query.jewelleryTypeId ? { jewelleryTypeId: query.jewelleryTypeId } : {}), ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}) },
    include: { jewelleryType: true },
  });
  const totals = await sdb.stockItem.groupBy({ by: ['groupId'], where: { status: 'AVAILABLE' }, _sum: { net: true, pcs: true } });
  const byGroup = new Map(totals.map((t) => [t.groupId, t]));
  const rows: ShortageRowDto[] = [];
  for (const g of groups) {
    const t = byGroup.get(g.id);
    const net = t?._sum.net != null ? Number(t._sum.net) : 0;
    const pcs = t?._sum.pcs ?? 0;
    const min = g.minWeight != null ? Number(g.minWeight) : null;
    const status: ShortageRowDto['status'] = min != null && net < min ? 'SHORTAGE' : min != null && net < min * 1.2 ? 'WARNING' : 'OK';
    if (query.status && status !== query.status) continue;
    rows.push({ level: 'GROUP', id: g.id, name: g.name, stockClass: g.stockClass, jewelleryType: g.jewelleryType?.name ?? null, currentWeight: net.toFixed(3), currentPcs: pcs, minWeight: g.minWeight != null ? num(g.minWeight) : null, maxWeight: g.maxWeight != null ? num(g.maxWeight) : null, minPcs: g.minPcs, maxPcs: g.maxPcs, status });
  }
  return rows;
}

// ───────────── CSV import ─────────────

const CSV_COLS = ['item_name', 'tag_no', 'huid', 'karat', 'pcs', 'gross', 'less', 'tunch', 'wastage', 'stone_charge', 'labour', 'labour_unit', 'other', 'rate', 'purchase_cost', 'remarks'];

/** Minimal CSV parser: handles quoted fields + escaped quotes; no embedded newlines inside quotes. */
function parseCsv(text: string): string[][] {
  return text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').map((line) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  });
}

export async function importStock(ctx: TenantContext, csv: string, fields: { stockClass: StockClass; method: 'LOOSE' | 'TAG'; groupId: number; dryRun: boolean }): Promise<StockImportResultDto> {
  const sdb = scopedDb(ctx);
  const group = await sdb.itemGroup.findUnique({ where: { id: fields.groupId } });
  if (!group) throw new HttpError(404, 'NOT_FOUND', 'Item group not found');

  const table = parseCsv(csv);
  const errors: StockImportResultDto['errors'] = [];
  if (table.length === 0) throw new HttpError(400, 'VALIDATION', 'Empty CSV');
  const header = table[0]!.map((h) => h.toLowerCase());
  const dataRows = table.slice(1);
  // shortcut: 500-row cap matches stockEntryBody.max(500); add batching if shops need bigger imports.
  if (dataRows.length > 500) throw new HttpError(400, 'VALIDATION', 'CSV exceeds 500 rows');
  const col = (r: string[], name: string) => { const idx = header.indexOf(name); return idx >= 0 ? (r[idx] ?? '') : ''; };

  // Resolve item names in the group by name.
  const names = await sdb.itemName.findMany({ where: { groupId: fields.groupId } });
  const byName = new Map(names.map((n) => [n.name.toLowerCase(), n]));

  // CSV→row maps: item_name resolved by name, the rest validated by the shared stockRowInput zod (row-scoped errors).
  const CELL: Record<string, string> = { tagNo: 'tag_no', huid: 'huid', karatCode: 'karat', pcs: 'pcs', gross: 'gross', less: 'less', tunch: 'tunch', wastage: 'wastage', stoneCharge: 'stone_charge', labour: 'labour', other: 'other', rate: 'rate', purchaseCost: 'purchase_cost', remarks: 'remarks' };
  const parsed: any[] = [];
  dataRows.forEach((r, i) => {
    const rowNo = i + 2; // 1-based incl header
    const itemName = byName.get(col(r, 'item_name').toLowerCase());
    if (!itemName) { errors.push({ row: rowNo, field: 'item_name', message: `Unknown item name "${col(r, 'item_name')}"` }); return; }
    const raw: Record<string, string | number> = { itemNameId: itemName.id };
    for (const [field, cell] of Object.entries(CELL)) { const v = col(r, cell); if (v !== '') raw[field] = v; }
    if (col(r, 'labour_unit')) raw.labourUnit = col(r, 'labour_unit').toUpperCase();
    const res = stockRowInput.safeParse(raw);
    if (!res.success) { for (const issue of res.error.issues) errors.push({ row: rowNo, field: String(issue.path[0] ?? ''), message: issue.message }); return; }
    if (res.data.less > res.data.gross) { errors.push({ row: rowNo, field: 'less', message: 'less cannot exceed gross' }); return; }
    parsed.push(res.data);
  });

  // dryRun, or a real run that hit row errors, validates only — echo the requested dryRun value.
  if (fields.dryRun || errors.length) {
    return { dryRun: fields.dryRun, total: dataRows.length, valid: parsed.length, imported: 0, errors, entryNo: null };
  }
  const result = await createStockEntry(ctx, { stockClass: fields.stockClass, method: fields.method, rows: parsed });
  return { dryRun: false, total: dataRows.length, valid: parsed.length, imported: result.items.length, errors, entryNo: result.entryNo };
}

export function sampleCsv(): string {
  return [CSV_COLS.join(','), 'Gold Ring,,,,1,10.500,0.200,91.67,2,0,500,PER_GRAM,0,,52000,sample tag row', 'Gold Chain,,,22K,1,22.000,0,91.67,0,0,8,PERCENT,0,,,sample loose row'].join('\n');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

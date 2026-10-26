import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { SETTING_SCHEMAS } from '../../shared';
import type {
  BankAccountDto,
  CurrentRatesDto,
  HsnDto,
  KaratDto,
  Metal,
  PartyDto,
  PartyListItemDto,
  OccasionDto,
  PartyRefDto,
  Paged,
  RateHistoryDto,
  RateLimitDto,
  RateRowDto,
  RateUnitKey,
  SettingKey,
  SettingsDto,
} from '../../shared';
import { SETTING_KEYS } from '../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });
const partyListItem = (p: any): PartyListItemDto => ({
  ...partyRef(p),
  parent: p.parent ? { id: p.parent.id, name: p.parent.name } : null,
  memberCount: p._count?.members ?? 0,
  isActive: p.isActive,
  createdAt: p.createdAt.toISOString(),
});
const partyDto = (p: any): PartyDto => ({
  ...partyListItem(p),
  countryCode: p.countryCode,
  email: p.email,
  address: p.address,
  birthday: p.birthday ? p.birthday.toISOString() : null,
  anniversary: p.anniversary ? p.anniversary.toISOString() : null,
  aadhaar: p.aadhaar,
  pan: p.pan,
  gstin: p.gstin,
  licenseNo: p.licenseNo,
  regNo: p.regNo,
  logoTitle: p.logoTitle,
  stateId: p.stateId,
  districtId: p.districtId,
  area: p.area,
  shopAddress: p.shopAddress,
  pinCode: p.pinCode,
  specialty: p.specialty,
  photoUrl: p.photoUrl,
  shopLogoUrl: p.shopLogoUrl,
  members: (p.members ?? []).map(partyRef),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ───────────── Parties ─────────────

export async function listParties(ctx: TenantContext, query: { page: number; pageSize: number; q?: string; type?: string; active?: 'true' | 'false' }): Promise<Paged<PartyListItemDto>> {
  const sdb = scopedDb(ctx);
  const where = {
    ...(query.type ? { type: query.type as never } : {}),
    ...(query.active ? { isActive: query.active === 'true' } : {}),
    ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { mobile: { contains: query.q } }, { shopName: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.party.findMany({ where, include: { parent: true, _count: { select: { members: true } } }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { name: 'asc' } }),
    sdb.party.count({ where }),
  ]);
  return { items: rows.map(partyListItem), total, page: query.page, pageSize: query.pageSize };
}

export async function searchParties(ctx: TenantContext, query: { q: string; type?: string; limit: number }): Promise<PartyRefDto[]> {
  const rows = await scopedDb(ctx).party.findMany({
    where: {
      isActive: true,
      ...(query.type ? { type: query.type as never } : {}),
      OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }, { shopName: { contains: query.q, mode: 'insensitive' } }],
    },
    take: query.limit,
    orderBy: { name: 'asc' },
  });
  return rows.map(partyRef);
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** TASK-89: active parties whose birthday/anniversary falls within the next `days` IST days (today = daysAway 0).
 *  Feb-29 occasions show on Feb-28 in non-leap years; only the nearest future occurrence per occasion. */
export async function listOccasions(ctx: TenantContext, days: number, now: Date = new Date()): Promise<OccasionDto[]> {
  const parties = await scopedDb(ctx).party.findMany({
    where: { isActive: true, OR: [{ birthday: { not: null } }, { anniversary: { not: null } }] },
    select: { id: true, type: true, name: true, mobile: true, shopName: true, birthday: true, anniversary: true },
  });
  const istNow = new Date(now.getTime() + 330 * 60000); // IST calendar via +5:30 shift; UTC getters then read IST Y/M/D
  const todayMs = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const out: OccasionDto[] = [];
  const add = (p: (typeof parties)[number], kind: 'BIRTHDAY' | 'ANNIVERSARY', d: Date | null) => {
    if (!d) return;
    const mon = d.getUTCMonth();
    const day = d.getUTCDate();
    for (const year of [istNow.getUTCFullYear(), istNow.getUTCFullYear() + 1]) {
      const adjDay = mon === 1 && day === 29 && !isLeapYear(year) ? 28 : day;
      const occMs = Date.UTC(year, mon, adjDay);
      const daysAway = Math.round((occMs - todayMs) / 86_400_000);
      if (daysAway >= 0 && daysAway <= days) {
        out.push({ party: partyRef(p), kind, date: new Date(occMs).toISOString().slice(0, 10), daysAway });
        break; // nearest future occurrence only
      }
    }
  };
  for (const p of parties) {
    add(p, 'BIRTHDAY', p.birthday);
    add(p, 'ANNIVERSARY', p.anniversary);
  }
  return out.sort((a, b) => a.daysAway - b.daysAway || a.party.name.localeCompare(b.party.name));
}

export async function getParty(ctx: TenantContext, partyId: number): Promise<PartyDto> {
  const p = await scopedDb(ctx).party.findUnique({ where: { id: partyId }, include: { parent: true, members: true, _count: { select: { members: true } } } });
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  return partyDto(p);
}

export async function createParty(ctx: TenantContext, body: Record<string, any>): Promise<{ dto: PartyDto; duplicateIds: number[] }> {
  const sdb = scopedDb(ctx);
  if (body.parentId != null) {
    const parent = await sdb.party.findUnique({ where: { id: body.parentId } });
    if (!parent || parent.type !== 'CUSTOMER') throw new HttpError(400, 'VALIDATION', 'parentId must be a customer of this business');
  }
  const dupes = await sdb.party.findMany({ where: { mobile: body.mobile }, select: { id: true } });
  const created = await sdb.party.create({
    data: { ...body, createdBranchId: ctx.activeBranchId ?? ctx.scopeBranchId, createdById: ctx.userId } as never,
    include: { parent: true, members: true, _count: { select: { members: true } } },
  });
  return { dto: partyDto(created), duplicateIds: dupes.map((d) => d.id) };
}

export async function updateParty(ctx: TenantContext, partyId: number, body: Record<string, any>): Promise<PartyDto> {
  const sdb = scopedDb(ctx);
  const target = await sdb.party.findUnique({ where: { id: partyId }, include: { members: { select: { id: true } } } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  if (body.parentId != null) {
    if (body.parentId === partyId) throw new HttpError(400, 'VALIDATION', 'A party cannot be its own parent');
    if (target.members.some((m) => m.id === body.parentId)) throw new HttpError(400, 'VALIDATION', 'Cannot set parent to one of its own members');
    const parent = await sdb.party.findUnique({ where: { id: body.parentId } });
    if (!parent || parent.type !== 'CUSTOMER') throw new HttpError(400, 'VALIDATION', 'parentId must be a customer of this business');
  }
  if (body.type != null && body.type !== 'CUSTOMER' && target.members.length > 0) {
    throw new HttpError(400, 'VALIDATION', 'Cannot change type: this customer has family members');
  }
  await sdb.party.update({ where: { id: partyId }, data: body });
  return getParty(ctx, partyId);
}

export async function deleteParty(ctx: TenantContext, partyId: number): Promise<void> {
  const target = await scopedDb(ctx).party.findUnique({ where: { id: partyId } });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  await scopedDb(ctx).party.update({ where: { id: partyId }, data: { isActive: false } });
}

// ───────────── Bank accounts ─────────────

export async function listBankAccounts(ctx: TenantContext, applyTo?: string): Promise<BankAccountDto[]> {
  const visibleBranchIds = [0, ...(ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds)];
  const rows = await scopedDb(ctx).bankAccount.findMany({ where: { branchId: { in: visibleBranchIds }, ...(applyTo ? { applyTo: applyTo as never } : {}) }, orderBy: { id: 'asc' } });
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter((b) => b !== 0))];
  const branches = branchIds.length ? await scopedDb(ctx).branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [];
  const bName = new Map(branches.map((b) => [b.id, b.name]));
  return rows.map((r) => ({
    id: r.id,
    branchId: r.branchId,
    branchName: r.branchId === 0 ? null : (bName.get(r.branchId) ?? null),
    bankName: r.bankName,
    bankBranchName: r.branchName,
    accountNo: r.accountNo,
    ifsc: r.ifsc,
    applyTo: r.applyTo,
    isActive: r.isActive,
  }));
}

export async function createBankAccount(ctx: TenantContext, body: Record<string, any>): Promise<BankAccountDto[]> {
  if (body.branchId !== 0 && !ctx.branchIds.includes(body.branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  await scopedDb(ctx).bankAccount.create({ data: { branchId: body.branchId, bankName: body.bankName, branchName: body.branchName ?? null, accountNo: body.accountNo, ifsc: body.ifsc, applyTo: body.applyTo, isActive: body.isActive } as never });
  return listBankAccounts(ctx);
}

export async function updateBankAccount(ctx: TenantContext, accountId: number, body: Record<string, any>): Promise<BankAccountDto[]> {
  if (body.branchId != null && body.branchId !== 0 && !ctx.branchIds.includes(body.branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const { branchName, ...rest } = body;
  await scopedDb(ctx).bankAccount.update({ where: { id: accountId }, data: { ...rest, ...(branchName !== undefined ? { branchName } : {}) } });
  return listBankAccounts(ctx);
}

export async function deleteBankAccount(ctx: TenantContext, accountId: number): Promise<void> {
  await scopedDb(ctx).bankAccount.update({ where: { id: accountId }, data: { isActive: false } });
}

// ───────────── HSN ─────────────

export async function listHsn(ctx: TenantContext, query: { q?: string; category?: string; onlyActive?: 'true' | 'false' }): Promise<HsnDto[]> {
  const codes = await prisma.hsnCode.findMany({
    where: { ...(query.category ? { category: query.category as never } : {}), ...(query.q ? { OR: [{ code: { contains: query.q } }, { productType: { contains: query.q, mode: 'insensitive' } }] } : {}) },
    orderBy: { code: 'asc' },
  });
  const toggles = await scopedDb(ctx).businessHsn.findMany();
  const toggle = new Map(toggles.map((t) => [t.hsnId, t.isActive]));
  let items = codes.map((c): HsnDto => ({ id: c.id, code: c.code, category: c.category, productType: c.productType, gstRate: c.gstRate.toString(), active: toggle.has(c.id) ? toggle.get(c.id)! : c.isActive }));
  if (query.onlyActive === 'true') items = items.filter((i) => i.active);
  return items;
}

export async function toggleHsn(ctx: TenantContext, hsnId: number, active: boolean): Promise<void> {
  if (!(await prisma.hsnCode.findUnique({ where: { id: hsnId } }))) throw new HttpError(404, 'NOT_FOUND', 'HSN code not found');
  await scopedDb(ctx).businessHsn.upsert({ where: { businessId_hsnId: { businessId: ctx.businessId!, hsnId } }, update: { isActive: active }, create: { hsnId, isActive: active } as never });
}

// ───────────── Karats ─────────────

const karatDto = (k: { id: number; metal: Metal; code: string; title: string; touch: unknown; isSystem: boolean }): KaratDto => ({ id: k.id, metal: k.metal, code: k.code, title: k.title, touch: String(k.touch), isSystem: k.isSystem });

export async function listKarats(ctx: TenantContext, metal?: Metal): Promise<KaratDto[]> {
  const rows = await scopedDb(ctx).karatMapping.findMany({ where: metal ? { metal } : {}, orderBy: [{ metal: 'asc' }, { sort: 'asc' }, { id: 'asc' }] });
  return rows.map(karatDto);
}

export async function createKarat(ctx: TenantContext, body: { metal: Metal; code: string; title: string; touch: number }): Promise<KaratDto> {
  const k = await scopedDb(ctx).karatMapping.create({ data: { metal: body.metal, code: body.code, title: body.title, touch: body.touch } as never });
  return karatDto(k);
}

export async function updateKarat(ctx: TenantContext, karatId: number, body: { title?: string; touch?: number }): Promise<KaratDto> {
  const k = await scopedDb(ctx).karatMapping.update({ where: { id: karatId }, data: body });
  return karatDto(k);
}

export async function deleteKarat(ctx: TenantContext, karatId: number): Promise<void> {
  const k = await scopedDb(ctx).karatMapping.findUnique({ where: { id: karatId } });
  if (!k) throw new HttpError(404, 'NOT_FOUND', 'Karat not found');
  if (k.isSystem) throw new HttpError(400, 'VALIDATION', 'System karats cannot be deleted');
  await scopedDb(ctx).karatMapping.delete({ where: { id: karatId } });
}

// ───────────── Rates & limits ─────────────

const DEFAULT_UNIT: Record<Metal, RateUnitKey> = { GOLD: 'GRAM_10', SILVER: 'KG_1' };

async function metalRates(ctx: TenantContext, metal: Metal): Promise<CurrentRatesDto['gold']> {
  const sdb = scopedDb(ctx);
  const pick = (branchId: number) => sdb.metalRate.findFirst({ where: { metal, branchId }, orderBy: { effectiveAt: 'desc' } });
  let head = ctx.activeBranchId != null ? await pick(ctx.activeBranchId) : null;
  if (!head) head = await pick(0);
  if (!head) return { rateUnit: DEFAULT_UNIT[metal], updatedAt: null, rows: [] };
  const [rows, karats] = await Promise.all([
    sdb.metalRate.findMany({ where: { metal, branchId: head.branchId, rateUnit: head.rateUnit, effectiveAt: head.effectiveAt } }),
    sdb.karatMapping.findMany({ where: { metal } }),
  ]);
  const byCode = new Map(karats.map((k) => [k.code, k]));
  const rateRows: RateRowDto[] = rows.map((r) => ({ karatCode: r.karatCode, title: byCode.get(r.karatCode)?.title ?? r.karatCode, touch: String(byCode.get(r.karatCode)?.touch ?? ''), sellRate: r.sellRate.toString(), buyRate: r.buyRate.toString() }));
  return { rateUnit: head.rateUnit as RateUnitKey, updatedAt: head.effectiveAt.toISOString(), rows: rateRows };
}

export async function currentRates(ctx: TenantContext): Promise<CurrentRatesDto> {
  const [gold, silver] = await Promise.all([metalRates(ctx, 'GOLD'), metalRates(ctx, 'SILVER')]);
  return { branchId: ctx.activeBranchId, gold, silver };
}

/** Returns offending rows if any rate is outside its limit; caller decides whether an override (with MPIN) is allowed. */
export async function checkRateLimits(ctx: TenantContext, body: { metal: Metal; rateUnit: RateUnitKey; rates: { karatCode: string; sellRate: number; buyRate: number }[] }): Promise<{ karatCode: string; sellRate: number; buyRate: number }[]> {
  const limit = (await scopedDb(ctx).rateLimit.findMany({ where: { metal: body.metal, rateUnit: body.rateUnit } }))[0];
  if (!limit) return [];
  const min = Number(limit.minRate);
  const max = Number(limit.maxRate);
  return body.rates.filter((r) => r.sellRate < min || r.sellRate > max || r.buyRate < min || r.buyRate > max);
}

export async function setRates(ctx: TenantContext, body: { metal: Metal; rateUnit: RateUnitKey; branchId?: number; rates: { karatCode: string; sellRate: number; buyRate: number }[] }): Promise<CurrentRatesDto> {
  const branchId = body.branchId ?? 0;
  if (branchId !== 0) {
    if (ctx.level !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Only admins can set branch rate overrides');
    if (!(await scopedDb(ctx).branch.findUnique({ where: { id: branchId } }))) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  }
  const effectiveAt = new Date();
  await scopedDb(ctx).metalRate.createMany({
    data: body.rates.map((r) => ({ branchId, metal: body.metal, karatCode: r.karatCode, rateUnit: body.rateUnit, sellRate: r.sellRate, buyRate: r.buyRate, effectiveAt, createdById: ctx.userId })) as never,
  });
  return currentRates(ctx);
}

export async function rateHistory(ctx: TenantContext, query: { page: number; pageSize: number; metal?: Metal }): Promise<Paged<RateHistoryDto>> {
  const sdb = scopedDb(ctx);
  const where = query.metal ? { metal: query.metal } : {};
  const [rows, total] = await Promise.all([
    sdb.metalRate.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { effectiveAt: 'desc' } }),
    sdb.metalRate.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ id: r.id, metal: r.metal, karatCode: r.karatCode, rateUnit: r.rateUnit as RateUnitKey, sellRate: r.sellRate.toString(), buyRate: r.buyRate.toString(), effectiveAt: r.effectiveAt.toISOString(), branchId: r.branchId, createdBy: null })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function listRateLimits(ctx: TenantContext): Promise<RateLimitDto[]> {
  const rows = await scopedDb(ctx).rateLimit.findMany({ orderBy: [{ metal: 'asc' }, { rateUnit: 'asc' }] });
  return rows.map((r) => ({ metal: r.metal, rateUnit: r.rateUnit as RateUnitKey, minRate: r.minRate.toString(), maxRate: r.maxRate.toString() }));
}

export async function putRateLimits(ctx: TenantContext, limits: { metal: Metal; rateUnit: RateUnitKey; minRate: number; maxRate: number }[]): Promise<RateLimitDto[]> {
  const sdb = scopedDb(ctx);
  // One transaction: replacing all limits must never leave a shop with zero limits mid-write.
  await sdb.$transaction([
    sdb.rateLimit.deleteMany({}),
    sdb.rateLimit.createMany({ data: limits.map((l) => ({ metal: l.metal, rateUnit: l.rateUnit, minRate: l.minRate, maxRate: l.maxRate })) as never }),
  ]);
  return listRateLimits(ctx);
}

// ───────────── Settings ─────────────

export async function getSettings(ctx: TenantContext): Promise<SettingsDto> {
  const rows = await scopedDb(ctx).setting.findMany({ where: { branchId: { in: [0, ...(ctx.activeBranchId != null ? [ctx.activeBranchId] : [])] } } });
  const business = new Map<string, unknown>();
  const branch = new Map<string, unknown>();
  for (const r of rows) (r.branchId === 0 ? business : branch).set(r.key, r.value);
  const out = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    const raw = branch.get(key) ?? business.get(key) ?? {};
    out[key] = SETTING_SCHEMAS[key].parse(raw ?? {});
  }
  return out as SettingsDto;
}

export async function putSetting(ctx: TenantContext, key: string, branchId: number | undefined, value: unknown): Promise<SettingsDto> {
  if (!(SETTING_KEYS as string[]).includes(key)) throw new HttpError(400, 'VALIDATION', `Unknown setting key: ${key}`);
  const parsed = SETTING_SCHEMAS[key as SettingKey].parse(value);
  const bId = branchId ?? 0;
  if (bId !== 0 && !(await scopedDb(ctx).branch.findUnique({ where: { id: bId } }))) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  await scopedDb(ctx).setting.upsert({
    where: { businessId_branchId_key: { businessId: ctx.businessId!, branchId: bId, key } },
    update: { value: parsed as object, updatedById: ctx.userId },
    create: { branchId: bId, key, value: parsed as object, updatedById: ctx.userId } as never,
  });
  return getSettings(ctx);
}

import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import { moneyToMetal, schemeMaturity } from '../../../shared';
import type { SchemeDto, SchemeGroupDto, EnrollmentDto, EnrollmentDetailDto, SchemePaymentDto, SchemeDueRowDto, SchemeTxnRowDto, SchemeDayBookDto } from '../../../shared';
import { currentRates } from '../service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const money = (v: unknown) => D(v).toFixed(2);
const wt = (v: unknown) => D(v).toFixed(3);
const GOLD_UNIT = 10; // gold scheme rates are per 10 g
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch (set X-Branch-Id)');
  return ctx.activeBranchId;
}
const branchScope = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);
const dateOnly = (d: Date) => ledger.businessDate(d);
/** startDate + (emiNo-1) months as a UTC-midnight @db.Date. */
function emiDateFor(start: Date, emiNo: number): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (emiNo - 1), start.getUTCDate()));
}
const todayGoldRate = async (ctx: TenantContext) => Number((await currentRates(ctx)).gold.rows[0]?.sellRate ?? 0);
const isP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Row-lock the enrollment inside a tx (serializes a concurrent payment against a redeem — BUG-13) and return its live status. */
async function lockEnrollment(tx: Prisma.TransactionClient, id: number): Promise<string> {
  const r = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "SchemeEnrollment" WHERE id = ${id} FOR UPDATE`;
  if (r.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
  return r[0]!.status;
}

// ───────────── Schemes ─────────────

export async function createScheme(ctx: TenantContext, body: any): Promise<SchemeDto> {
  const branchId = activeBranch(ctx);
  const s = await scopedDb(ctx).scheme.create({
    data: {
      businessId: ctx.businessId!, branchId, kind: body.kind, type: body.type, name: body.name, description: body.description ?? null,
      emiAmount: body.emiAmount, tenureMonths: body.tenureMonths, bonusType: body.bonusType, bonusValue: body.bonusValue,
      startDate: dateOnly(body.startDate), validityDate: body.validityDate ? dateOnly(body.validityDate) : null, createdById: ctx.userId,
    },
  });
  return (await buildSchemes(ctx, [s.id]))[0]!;
}

export async function listSchemes(ctx: TenantContext, q: any): Promise<{ items: SchemeDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  const where = { ...(q.kind ? { kind: q.kind } : {}), ...(q.type ? { type: q.type } : {}), ...(q.active ? { isActive: q.active === 'true' } : {}) };
  const [rows, total] = await Promise.all([
    sdb.scheme.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    sdb.scheme.count({ where }),
  ]);
  return { items: await buildSchemes(ctx, rows.map((r) => r.id)), total, page: q.page, pageSize: q.pageSize };
}

export async function getScheme(ctx: TenantContext, id: number): Promise<SchemeDto> {
  const [dto] = await buildSchemes(ctx, [id]);
  if (!dto) throw new HttpError(404, 'NOT_FOUND', 'Scheme not found');
  return dto;
}

export async function patchScheme(ctx: TenantContext, id: number, body: any): Promise<SchemeDto> {
  if (!(await scopedDb(ctx).scheme.findUnique({ where: { id } }))) throw new HttpError(404, 'NOT_FOUND', 'Scheme not found');
  await scopedDb(ctx).scheme.update({
    where: { id },
    data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.validityDate !== undefined ? { validityDate: body.validityDate ? dateOnly(body.validityDate) : null } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
  });
  return getScheme(ctx, id);
}

// ───────────── Groups ─────────────

export async function createGroup(ctx: TenantContext, body: any): Promise<SchemeGroupDto> {
  if (!(await scopedDb(ctx).scheme.findUnique({ where: { id: body.schemeId } }))) throw new HttpError(404, 'NOT_FOUND', 'Scheme not found');
  try {
    const g = await prisma.schemeGroup.create({ data: { schemeId: body.schemeId, name: body.name, memberLimit: body.memberLimit ?? null } });
    return { id: g.id, schemeId: g.schemeId, name: g.name, memberLimit: g.memberLimit, memberCount: 0 };
  } catch (e) {
    if (isP2002(e)) throw new HttpError(409, 'CONFLICT', 'A group with that name already exists in this scheme');
    throw e;
  }
}

export async function listGroups(ctx: TenantContext, q: any): Promise<SchemeGroupDto[]> {
  const sdb = scopedDb(ctx);
  const schemeIds = q.schemeId ? [q.schemeId] : (await sdb.scheme.findMany({ select: { id: true } })).map((s) => s.id);
  if (schemeIds.length === 0) return [];
  const groups = await prisma.schemeGroup.findMany({ where: { schemeId: { in: schemeIds } }, orderBy: { id: 'asc' } });
  const counts = await prisma.schemeEnrollment.groupBy({ by: ['groupId'], where: { groupId: { in: groups.map((g) => g.id) } }, _count: { _all: true } });
  const countMap = new Map(counts.map((c) => [c.groupId, c._count._all]));
  return groups.map((g) => ({ id: g.id, schemeId: g.schemeId, name: g.name, memberLimit: g.memberLimit, memberCount: countMap.get(g.id) ?? 0 }));
}

// ───────────── Enrollments ─────────────

export async function enroll(ctx: TenantContext, body: any): Promise<EnrollmentDetailDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const scheme = await sdb.scheme.findUnique({ where: { id: body.schemeId } });
  if (!scheme) throw new HttpError(404, 'NOT_FOUND', 'Scheme not found');
  if (!scheme.isActive) throw new HttpError(409, 'CONFLICT', 'Scheme is not active');
  if (!(await sdb.party.findUnique({ where: { id: body.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const goldRate = scheme.type === 'GOLD' ? await todayGoldRate(ctx) : 0;

  const enrollmentId = await prisma.$transaction(async (tx) => {
    if (body.groupId != null) {
      const grp = await tx.schemeGroup.findFirst({ where: { id: body.groupId, schemeId: scheme.id } });
      if (!grp) throw new HttpError(404, 'NOT_FOUND', 'Group not found');
      if (grp.memberLimit != null) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${body.groupId})`; // serialize member-limit checks for this group
        const count = await tx.schemeEnrollment.count({ where: { groupId: body.groupId } });
        if (count >= grp.memberLimit) throw new HttpError(409, 'CONFLICT', 'This group is full');
      }
    }
    let enrollment;
    try {
      enrollment = await tx.schemeEnrollment.create({
        data: {
          businessId: ctx.businessId!, branchId, schemeId: scheme.id, groupId: body.groupId ?? null, partyId: body.partyId,
          assignId: body.assignId, displayName: body.displayName, emiAmount: body.emiAmount ?? scheme.emiAmount,
          startDate: body.startDate ? dateOnly(body.startDate) : scheme.startDate, status: 'ACTIVE', createdById: ctx.userId,
        },
      });
    } catch (e) {
      if (isP2002(e)) throw new HttpError(409, 'CONFLICT', 'That assign id is already used in this scheme');
      throw e;
    }
    if (Number(body.tokenAmount) > 0) await postPayment(tx, ctx, enrollment, scheme, { amount: body.tokenAmount, medium: 'TOKEN' }, goldRate);
    if (body.firstPayment) await postPayment(tx, ctx, enrollment, scheme, body.firstPayment, goldRate);
    return enrollment.id;
  });
  return getEnrollment(ctx, enrollmentId);
}

/** Core payment post, used by enroll (token/first) and addPayment — assumes enrollment/scheme already validated + scoped. */
async function postPayment(tx: Prisma.TransactionClient, ctx: TenantContext, enrollment: any, scheme: any, input: any, goldRate: number) {
  const medium = input.medium ?? 'CASH';
  // emiNo: TOKEN never takes a slot; EMI schemes assign given-or-lowest-unpaid 1..tenure
  let emiNo: number | null = null;
  let emiDate: Date | null = null;
  if (medium !== 'TOKEN' && scheme.tenureMonths > 0) {
    if (input.emiNo != null) {
      if (input.emiNo > scheme.tenureMonths) throw new HttpError(400, 'VALIDATION', 'EMI number exceeds the tenure');
      emiNo = input.emiNo;
    } else {
      const taken = new Set((await tx.schemePayment.findMany({ where: { enrollmentId: enrollment.id, emiNo: { not: null }, isReversed: false }, select: { emiNo: true } })).map((p) => p.emiNo));
      emiNo = null;
      for (let m = 1; m <= scheme.tenureMonths; m++) if (!taken.has(m)) { emiNo = m; break; }
      if (emiNo == null) throw new HttpError(409, 'CONFLICT', 'All installments are already paid');
    }
    emiDate = emiDateFor(enrollment.startDate, emiNo!);
  }
  const txnDate = input.txnDate ? dateOnly(input.txnDate) : ledger.businessDate();
  const gold = scheme.type === 'GOLD';
  const rate = gold ? (input.rate != null ? Number(input.rate) : goldRate) : null;
  const fine = gold ? moneyToMetal(input.amount, rate ?? 0, GOLD_UNIT) : null;
  if (medium === 'ONLINE' && input.bankAccountId != null && !(await scopedDb(ctx).bankAccount.findUnique({ where: { id: input.bankAccountId } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');

  let pay;
  try {
    pay = await tx.schemePayment.create({
      data: { enrollmentId: enrollment.id, emiNo, emiDate, txnDate, amount: input.amount, medium, bankAccountId: input.bankAccountId ?? null, rate, fine, remark: input.remark ?? null, createdById: ctx.userId },
    });
  } catch (e) {
    if (isP2002(e)) throw new HttpError(409, 'CONFLICT', 'That installment is already paid');
    throw e;
  }
  // CASH/ONLINE/TOKEN move money; DRAW/VENDOR are counted but move nothing
  if (medium === 'CASH' || medium === 'ONLINE' || medium === 'TOKEN') {
    await ledger.post(tx, lctxOf(ctx), [{ branchId: enrollment.branchId, txnDate, asset: 'MONEY', direction: 'IN', bankAccountId: medium === 'ONLINE' ? (input.bankAccountId ?? null) : null, amount: input.amount, source: 'SCHEME', sourceId: `${enrollment.id}-${pay.id}`, narration: `Scheme payment (${scheme.name})` }]);
  }
  await logActivity(tx, ctx, { module: 'SCHEME', action: 'CREATED', entity: 'SchemePayment', entityId: String(pay.id), summary: `Scheme payment ₹${input.amount} on ${enrollment.assignId}` });
  return pay;
}

export async function addPayment(ctx: TenantContext, body: any): Promise<EnrollmentDetailDto> {
  const sdb = scopedDb(ctx);
  const enrollment = await sdb.schemeEnrollment.findUnique({ where: { id: body.enrollmentId } });
  if (!enrollment) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
  if (enrollment.status !== 'ACTIVE' && enrollment.status !== 'WON') throw new HttpError(409, 'CONFLICT', `Cannot add money to a ${enrollment.status.toLowerCase()} enrollment`);
  const scheme = await sdb.scheme.findUniqueOrThrow({ where: { id: enrollment.schemeId } });
  const goldRate = scheme.type === 'GOLD' ? await todayGoldRate(ctx) : 0;
  await prisma.$transaction(async (tx) => {
    // lock first so a redeem in flight either sees this payment or closes before it (BUG-13)
    const status = await lockEnrollment(tx, enrollment.id);
    if (status !== 'ACTIVE' && status !== 'WON') throw new HttpError(409, 'CONFLICT', `Cannot add money to a ${status.toLowerCase()} enrollment`);
    await postPayment(tx, ctx, enrollment, scheme, body, goldRate);
  });
  return getEnrollment(ctx, enrollment.id);
}

export async function reversePayment(ctx: TenantContext, paymentId: number): Promise<EnrollmentDetailDto> {
  const sdb = scopedDb(ctx);
  // reach the payment through its scoped enrollment
  const pay = await prisma.schemePayment.findFirst({ where: { id: paymentId, enrollment: { businessId: ctx.businessId!, branchId: { in: branchScope(ctx) } } }, include: { enrollment: true } });
  if (!pay) throw new HttpError(404, 'NOT_FOUND', 'Payment not found');
  if (pay.enrollment.status !== 'ACTIVE' && pay.enrollment.status !== 'WON') throw new HttpError(409, 'CONFLICT', 'Enrollment is closed');
  await prisma.$transaction(async (tx) => {
    const r = await tx.schemePayment.updateMany({ where: { id: paymentId, isReversed: false }, data: { isReversed: true, emiNo: null } });
    if (r.count !== 1) throw new HttpError(409, 'CONFLICT', 'Payment already reversed');
    if (pay.medium === 'CASH' || pay.medium === 'ONLINE' || pay.medium === 'TOKEN') await ledger.reverse(tx, lctxOf(ctx), { source: 'SCHEME', sourceId: `${pay.enrollmentId}-${pay.id}` });
    await logActivity(tx, ctx, { module: 'SCHEME', action: 'REVERSED', entity: 'SchemePayment', entityId: String(paymentId), summary: `Reversed scheme payment on ${pay.enrollment.assignId}` });
  });
  return getEnrollment(ctx, pay.enrollmentId);
}

export async function markWon(ctx: TenantContext, id: number): Promise<EnrollmentDetailDto> {
  const sdb = scopedDb(ctx);
  const e = await sdb.schemeEnrollment.findUnique({ where: { id } });
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
  await prisma.$transaction(async (tx) => {
    const r = await tx.schemeEnrollment.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'WON' } });
    if (r.count !== 1) throw new HttpError(409, 'CONFLICT', 'Only an active enrollment can be marked won');
    await logActivity(tx, ctx, { module: 'SCHEME', action: 'EDITED', entity: 'SchemeEnrollment', entityId: String(id), summary: `Enrollment ${e.assignId} won the draw` });
  });
  return getEnrollment(ctx, id);
}

export async function redeem(ctx: TenantContext, id: number, body: any): Promise<EnrollmentDetailDto> {
  const sdb = scopedDb(ctx);
  const e = await sdb.schemeEnrollment.findUnique({ where: { id } });
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
  if (e.status !== 'ACTIVE' && e.status !== 'WON') throw new HttpError(409, 'CONFLICT', `A ${e.status.toLowerCase()} enrollment cannot be redeemed`);
  const scheme = await sdb.scheme.findUniqueOrThrow({ where: { id: e.schemeId } });
  const gold = scheme.type === 'GOLD';
  const redeemRate = gold ? (body.redeemRate != null ? Number(body.redeemRate) : await todayGoldRate(ctx)) : 0;
  const newStatus = body.early ? 'WITHDRAWN' : 'CLOSED';

  await prisma.$transaction(async (tx) => {
    // lock the row BEFORE reading payments, so a concurrent addPayment is either included here or blocked out (BUG-13)
    const status = await lockEnrollment(tx, id);
    if (status !== 'ACTIVE' && status !== 'WON') throw new HttpError(409, 'CONFLICT', 'Enrollment was just closed');
    const payments = await tx.schemePayment.findMany({ where: { enrollmentId: id, isReversed: false } });
    const emisPaid = payments.filter((p) => p.emiNo != null).length;
    if (!body.early && emisPaid < scheme.tenureMonths) throw new HttpError(409, 'CONFLICT', 'Not matured — withdraw instead');
    const m = schemeMaturity({ type: scheme.type, payments: payments.map((p) => ({ amount: p.amount, fine: p.fine })), bonusType: scheme.bonusType, bonusValue: scheme.bonusValue, emiAmount: e.emiAmount, redeemRate, rateUnitGrams: GOLD_UNIT, early: body.early });
    const r = await tx.schemeEnrollment.updateMany({ where: { id, status: { in: ['ACTIVE', 'WON'] } }, data: { status: newStatus, redeemValue: m.maturityValue, redeemFine: gold ? m.maturity : null, redeemRate: gold ? redeemRate : null, closedAt: new Date() } });
    if (r.count !== 1) throw new HttpError(409, 'CONFLICT', 'Enrollment was just closed');
    // credit the customer (shop owes them the maturity value); a Sell Bill nets it like an order advance
    if (Number(m.maturityValue) > 0) await udhar.post(tx, lctxOf(ctx), [{ branchId: e.branchId, partyId: e.partyId, txnDate: ledger.businessDate(), amount: D(m.maturityValue).negated(), source: 'SCHEME', sourceId: String(id), narration: `Scheme ${body.early ? 'withdrawal' : 'maturity'} ${e.assignId}` }]);
    await logActivity(tx, ctx, { module: 'SCHEME', action: body.early ? 'DELETED' : 'EDITED', entity: 'SchemeEnrollment', entityId: String(id), summary: `Enrollment ${e.assignId} ${body.early ? 'withdrawn' : 'redeemed'} (₹${m.maturityValue})` });
  });
  return getEnrollment(ctx, id);
}

export async function listEnrollments(ctx: TenantContext, q: any): Promise<{ items: EnrollmentDto[]; total: number; page: number; pageSize: number }> {
  const where = enrollmentWhere(ctx, q);
  const [rows, total] = await Promise.all([
    prisma.schemeEnrollment.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    prisma.schemeEnrollment.count({ where }),
  ]);
  let items = (await Promise.all(rows.map((r) => buildEnrollment(ctx, r.id, false)))).filter((e): e is EnrollmentDto => !!e);
  if (q.due === 'true') items = items.filter((e) => e.emisDue > 0);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function getEnrollment(ctx: TenantContext, id: number): Promise<EnrollmentDetailDto> {
  const dto = await buildEnrollment(ctx, id, true);
  if (!dto) throw new HttpError(404, 'NOT_FOUND', 'Enrollment not found');
  return dto as EnrollmentDetailDto;
}

export async function dues(ctx: TenantContext, q: any): Promise<SchemeDueRowDto[]> {
  const where = { businessId: ctx.businessId!, branchId: { in: branchScope(ctx) }, status: { in: ['ACTIVE', 'WON'] as any }, ...(q.schemeId ? { schemeId: q.schemeId } : {}), ...(q.groupId ? { groupId: q.groupId } : {}), ...(q.kind ? { scheme: { kind: q.kind } } : {}) };
  const rows = await prisma.schemeEnrollment.findMany({ where, select: { id: true } });
  const built = await Promise.all(rows.map((r) => buildEnrollment(ctx, r.id, false)));
  return built.filter((e): e is EnrollmentDto => !!e && e.emisDue > 0).map((e) => ({
    enrollmentId: e.id, assignId: e.assignId, displayName: e.displayName, party: e.party, scheme: { id: e.scheme.id, name: e.scheme.name }, group: e.group,
    emiAmount: e.emiAmount, emisDue: e.emisDue, dueAmount: money(D(e.emiAmount).times(e.emisDue)), oldestDueDate: e.nextEmiDate ?? '',
  }));
}

export async function transactions(ctx: TenantContext, q: any): Promise<{ items: SchemeTxnRowDto[]; total: number; page: number; pageSize: number }> {
  const where = txnWhere(ctx, q);
  const [rows, total] = await Promise.all([
    prisma.schemePayment.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: txnInclude }),
    prisma.schemePayment.count({ where }),
  ]);
  return { items: await decorateTxns(ctx, rows), total, page: q.page, pageSize: q.pageSize };
}

export async function dayBook(ctx: TenantContext, q: any): Promise<SchemeDayBookDto> {
  const from = dateOnly(q.from ?? new Date());
  const to = dateOnly(q.to ?? new Date());
  const sdb = scopedDb(ctx);
  const ledgerWhere = { source: 'SCHEME' as const, asset: 'MONEY' as const };
  const [before, inRange] = await Promise.all([
    sdb.ledgerEntry.findMany({ where: { ...ledgerWhere, txnDate: { lt: from } }, select: { direction: true, amount: true } }),
    sdb.ledgerEntry.findMany({ where: { ...ledgerWhere, txnDate: { gte: from, lte: to } }, select: { direction: true, amount: true } }),
  ]);
  const net = (rows: { direction: string; amount: Prisma.Decimal | null }[]) => rows.reduce((s, r) => (r.direction === 'IN' ? s.plus(r.amount ?? 0) : s.minus(r.amount ?? 0)), new Prisma.Decimal(0));
  const opening = net(before);
  const moneyIn = inRange.filter((r) => r.direction === 'IN').reduce((s, r) => s.plus(r.amount ?? 0), new Prisma.Decimal(0));
  const moneyOut = inRange.filter((r) => r.direction === 'OUT').reduce((s, r) => s.plus(r.amount ?? 0), new Prisma.Decimal(0));
  const txnRows = await prisma.schemePayment.findMany({ where: { ...txnWhere(ctx, { kind: q.kind }), txnDate: { gte: from, lte: to } }, orderBy: { id: 'desc' }, include: txnInclude });
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), opening: money(opening), moneyIn: money(moneyIn), moneyOut: money(moneyOut), closing: money(opening.plus(moneyIn).minus(moneyOut)), rows: await decorateTxns(ctx, txnRows) };
}

// ───────────── builders ─────────────

async function buildSchemes(ctx: TenantContext, ids: number[]): Promise<SchemeDto[]> {
  if (ids.length === 0) return [];
  const sdb = scopedDb(ctx);
  const schemes = await sdb.scheme.findMany({ where: { id: { in: ids } } });
  const branches = await sdb.branch.findMany({ where: { id: { in: [...new Set(schemes.map((s) => s.branchId))] } }, select: { id: true, name: true } });
  const counts = await prisma.schemeEnrollment.groupBy({ by: ['schemeId'], where: { schemeId: { in: ids } }, _count: { _all: true } });
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const countMap = new Map(counts.map((c) => [c.schemeId, c._count._all]));
  const byId = new Map(schemes.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({
    id: s.id, kind: s.kind, type: s.type, name: s.name, description: s.description, emiAmount: money(s.emiAmount), tenureMonths: s.tenureMonths,
    bonusType: s.bonusType, bonusValue: s.type === 'GOLD' ? wt(s.bonusValue) : money(s.bonusValue), startDate: s.startDate.toISOString().slice(0, 10),
    validityDate: s.validityDate?.toISOString().slice(0, 10) ?? null, isActive: s.isActive, branch: { id: s.branchId, name: branchMap.get(s.branchId) ?? '' },
    memberCount: countMap.get(s.id) ?? 0, createdAt: s.createdAt.toISOString(),
  }));
}

const enrollmentWhere = (ctx: TenantContext, q: any) => ({
  businessId: ctx.businessId!, branchId: { in: branchScope(ctx) },
  ...(q.schemeId ? { schemeId: q.schemeId } : {}), ...(q.groupId ? { groupId: q.groupId } : {}), ...(q.partyId ? { partyId: q.partyId } : {}),
  ...(q.status ? { status: q.status } : {}), ...(q.kind ? { scheme: { kind: q.kind } } : {}),
});

async function buildEnrollment(ctx: TenantContext, id: number, withPayments: boolean): Promise<EnrollmentDto | EnrollmentDetailDto | null> {
  const e = await prisma.schemeEnrollment.findFirst({ where: { id, businessId: ctx.businessId!, branchId: { in: branchScope(ctx) } }, include: { scheme: true, group: true } });
  if (!e) return null;
  const payments = await prisma.schemePayment.findMany({ where: { enrollmentId: id }, orderBy: { id: 'asc' } });
  const active = payments.filter((p) => !p.isReversed);
  const paidSlots = new Set(active.filter((p) => p.emiNo != null).map((p) => p.emiNo));
  const emisPaid = paidSlots.size;
  const tenure = e.scheme.tenureMonths;
  const today = ledger.businessDate();
  let emisDue = 0, nextEmiNo: number | null = null, nextEmiDate: string | null = null;
  for (let m = 1; m <= tenure; m++) {
    if (paidSlots.has(m)) continue;
    const d = emiDateFor(e.startDate, m);
    if (nextEmiNo == null) { nextEmiNo = m; nextEmiDate = d.toISOString().slice(0, 10); }
    if (d.getTime() <= today.getTime()) emisDue++;
  }
  const gold = e.scheme.type === 'GOLD';
  const redeemRate = gold ? await todayGoldRate(ctx) : 0;
  const maturity = schemeMaturity({ type: e.scheme.type, payments: active.map((p) => ({ amount: p.amount, fine: p.fine })), bonusType: e.scheme.bonusType, bonusValue: e.scheme.bonusValue, emiAmount: e.emiAmount, redeemRate, rateUnitGrams: GOLD_UNIT });

  const [party, branch, banks, users] = await Promise.all([
    scopedDb(ctx).party.findUnique({ where: { id: e.partyId }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }),
    scopedDb(ctx).branch.findUnique({ where: { id: e.branchId }, select: { id: true, name: true } }),
    withPayments ? scopedDb(ctx).bankAccount.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.bankAccountId).filter((x): x is number => x != null))] } }, select: { id: true, bankName: true } }) : [],
    withPayments ? prisma.user.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.createdById).filter((x): x is number => x != null))] }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const bankMap = new Map((banks as any[]).map((b) => [b.id, b.bankName]));
  const userMap = new Map((users as any[]).map((u) => [u.id, u.name]));
  const base: EnrollmentDto = {
    id: e.id, scheme: { id: e.scheme.id, name: e.scheme.name, kind: e.scheme.kind, type: e.scheme.type, tenureMonths: tenure }, group: e.group ? { id: e.group.id, name: e.group.name } : null,
    party: party as any, branch: branch as any, assignId: e.assignId, displayName: e.displayName, emiAmount: money(e.emiAmount), startDate: e.startDate.toISOString().slice(0, 10),
    status: e.status, emisPaid, emisDue, matured: emisPaid >= tenure, nextEmiNo, nextEmiDate, maturity,
    redeemValue: e.redeemValue != null ? money(e.redeemValue) : null, redeemFine: e.redeemFine != null ? wt(e.redeemFine) : null, redeemRate: e.redeemRate != null ? money(e.redeemRate) : null,
    closedAt: e.closedAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString(),
  };
  if (!withPayments) return base;
  return { ...base, payments: payments.map((p) => paymentDto(p, bankMap, userMap)) };
}

function paymentDto(p: any, bankMap: Map<number, string>, userMap: Map<number, string>): SchemePaymentDto {
  return {
    id: p.id, enrollmentId: p.enrollmentId, emiNo: p.emiNo, emiDate: p.emiDate?.toISOString().slice(0, 10) ?? null, txnDate: p.txnDate.toISOString().slice(0, 10),
    amount: money(p.amount), medium: p.medium, bankAccount: p.bankAccountId != null ? { id: p.bankAccountId, name: bankMap.get(p.bankAccountId) ?? '' } : null,
    rate: p.rate != null ? money(p.rate) : null, fine: p.fine != null ? wt(p.fine) : null, remark: p.remark, isReversed: p.isReversed,
    createdBy: p.createdById != null ? (userMap.get(p.createdById) ?? null) : null, createdAt: p.createdAt.toISOString(),
  };
}

const txnInclude = { enrollment: { include: { scheme: true, group: true } } } as const;
const txnWhere = (ctx: TenantContext, q: any) => ({
  enrollment: { businessId: ctx.businessId!, branchId: { in: branchScope(ctx) }, ...(q?.schemeId ? { schemeId: q.schemeId } : {}), ...(q?.groupId ? { groupId: q.groupId } : {}), ...(q?.kind ? { scheme: { kind: q.kind } } : {}) },
  ...(q?.medium ? { medium: q.medium } : {}),
  ...(q?.from || q?.to ? { txnDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
});

async function decorateTxns(ctx: TenantContext, rows: any[]): Promise<SchemeTxnRowDto[]> {
  const partyIds = [...new Set(rows.map((r) => r.enrollment.partyId))];
  const bankIds = [...new Set(rows.map((r) => r.bankAccountId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is number => x != null))];
  const sdb = scopedDb(ctx);
  const [parties, banks, users] = await Promise.all([
    partyIds.length ? sdb.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }) : [],
    bankIds.length ? sdb.bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, bankName: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const partyMap = new Map(parties.map((p) => [p.id, p]));
  const bankMap = new Map(banks.map((b) => [b.id, b.bankName]));
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((p) => ({
    ...paymentDto(p, bankMap, userMap),
    scheme: { id: p.enrollment.scheme.id, name: p.enrollment.scheme.name }, group: p.enrollment.group ? { id: p.enrollment.group.id, name: p.enrollment.group.name } : null,
    party: partyMap.get(p.enrollment.partyId) as any, assignId: p.enrollment.assignId,
  }));
}

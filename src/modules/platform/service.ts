import argon2 from 'argon2';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { checkedGeo } from '../../lib/geo';
import { signAccessToken } from '../../middleware/auth';
import { HttpError } from '../../middleware/error';
import { buildMe } from '../auth/service';
import { DEFAULT_KARATS } from '../../shared';
import type {
  BusinessDetailDto,
  BusinessListItemDto,
  LoginResponse,
  Paged,
  PaymentDto,
  PlanDto,
  PlatformDashboardDto,
  SignupRequestDto,
  SubscriptionDto,
} from '../../shared';

const DAY = 86_400_000;

const DEFAULT_RATE_LIMITS = [
  { metal: 'GOLD', rateUnit: 'GRAM_1', minRate: 14000, maxRate: 18000 },
  { metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 145000, maxRate: 200000 },
  { metal: 'GOLD', rateUnit: 'TOLA', minRate: 169000, maxRate: 202000 },
  { metal: 'SILVER', rateUnit: 'KG_1', minRate: 240000, maxRate: 300000 },
] as const;

/**
 * Idempotent, CREATE-ONLY per-business defaults (karat mappings + rate limits). Called by provisionBusiness and the
 * seed backfill. `update: {}` on purpose — re-running must never reset a shop's customised touch/limits.
 */
export async function ensureBusinessDefaults(tx: Prisma.TransactionClient, businessId: number): Promise<void> {
  for (let i = 0; i < DEFAULT_KARATS.length; i++) {
    const k = DEFAULT_KARATS[i]!;
    await tx.karatMapping.upsert({
      where: { businessId_metal_code: { businessId, metal: k.metal, code: k.code } },
      update: {},
      create: { businessId, metal: k.metal, code: k.code, title: k.title, touch: k.touch, isSystem: true, sort: i },
    });
  }
  for (const l of DEFAULT_RATE_LIMITS) {
    await tx.rateLimit.upsert({
      where: { businessId_metal_rateUnit: { businessId, metal: l.metal, rateUnit: l.rateUnit } },
      update: {},
      create: { businessId, metal: l.metal, rateUnit: l.rateUnit, minRate: l.minRate, maxRate: l.maxRate },
    });
  }
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const planDto = (p: any): PlanDto => ({
  id: p.id,
  name: p.name,
  description: p.description,
  durationDays: p.durationDays,
  price: p.price.toString(),
  maxBranches: p.maxBranches,
  maxUsers: p.maxUsers,
  modules: p.modules,
  isActive: p.isActive,
  activeSubscriptions: p._count?.subscriptions ?? 0,
});
const subDto = (s: any): SubscriptionDto => ({
  id: s.id,
  planId: s.planId,
  planName: s.plan.name,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  status: s.status,
  maxBranches: s.maxBranches,
  maxUsers: s.maxUsers,
  modules: s.modules,
  notes: s.notes,
  createdAt: s.createdAt.toISOString(),
});
/** business name + requested plan + the linked subscription's plan name for PaymentDto */
const PAYMENT_INCLUDE = { business: true, plan: { select: { name: true } }, subscription: { select: { plan: { select: { name: true } } } } } satisfies Prisma.SubscriptionPaymentInclude;
const paymentDto = (p: any): PaymentDto => ({
  id: p.id,
  businessId: p.businessId,
  businessName: p.business?.name ?? '',
  subscriptionId: p.subscriptionId,
  amount: p.amount.toString(),
  method: p.method,
  utr: p.utr,
  status: p.status,
  paidAt: p.paidAt ? p.paidAt.toISOString() : null,
  createdAt: p.createdAt.toISOString(),
  hasProof: p.screenshotUrl != null,
  // the plan the business asked for, else the linked subscription's plan
  planName: p.plan?.name ?? p.subscription?.plan?.name ?? null,
  renewOnConfirm: p.renewOnConfirm,
});
const signupDto = (s: any, stateName: string, districtName: string | null): SignupRequestDto => ({
  id: s.id,
  shopName: s.shopName,
  ownerName: s.ownerName,
  countryCode: s.countryCode,
  whatsapp: s.whatsapp,
  email: s.email,
  address: s.address,
  state: { id: s.stateId, name: stateName },
  district: s.districtId != null && districtName != null ? { id: s.districtId, name: districtName } : null,
  status: s.status,
  businessId: s.businessId,
  rejectReason: s.rejectReason,
  reviewedAt: s.reviewedAt ? s.reviewedAt.toISOString() : null,
  createdAt: s.createdAt.toISOString(),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const subscriptionState = (sub: { status: string; endsAt: Date } | undefined, now: Date, in15: Date): BusinessListItemDto['subscriptionState'] =>
  !sub ? 'none' : sub.status !== 'ACTIVE' || sub.endsAt < now ? 'expired' : sub.endsAt <= in15 ? 'expiring' : 'active';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const businessListItem = (b: any, now: Date, in15: Date): BusinessListItemDto => {
  const sub = b.subscriptions[0];
  return {
    id: b.id,
    name: b.name,
    ownerName: b.ownerName,
    mobile: b.mobile,
    status: b.status,
    subscriptionState: subscriptionState(sub, now, in15),
    planName: sub?.plan.name ?? null,
    endsAt: sub ? sub.endsAt.toISOString() : null,
    branchCount: b._count.branches,
    userCount: b._count.users,
    createdAt: b.createdAt.toISOString(),
  };
};

// ───────────── Dashboard ─────────────

export async function dashboard(): Promise<PlatformDashboardDto> {
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * DAY);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const [total, suspended, pendingSignups, branches, users, activeSubs, expiringSubs, mRev, yRev] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { status: 'SUSPENDED' } }),
    prisma.signupRequest.count({ where: { status: 'PENDING' } }),
    prisma.branch.count(),
    prisma.user.count({ where: { level: { not: 'SUPER_ADMIN' } } }),
    prisma.subscription.findMany({ where: { status: 'ACTIVE', endsAt: { gte: now } }, select: { businessId: true }, distinct: ['businessId'] }),
    prisma.subscription.findMany({ where: { status: 'ACTIVE', endsAt: { gte: now, lte: in15 } }, select: { businessId: true }, distinct: ['businessId'] }),
    prisma.subscriptionPayment.aggregate({ _sum: { amount: true }, where: { status: 'CONFIRMED', paidAt: { gte: monthStart } } }),
    prisma.subscriptionPayment.aggregate({ _sum: { amount: true }, where: { status: 'CONFIRMED', paidAt: { gte: yearStart } } }),
  ]);
  const activeIds = new Set(activeSubs.map((s) => s.businessId));
  const allBiz = await prisma.business.findMany({ select: { id: true, status: true } });
  let active = 0;
  let expired = 0;
  for (const b of allBiz) {
    if (b.status !== 'ACTIVE') continue;
    if (activeIds.has(b.id)) active++;
    else expired++;
  }
  return {
    businesses: { total, active, suspended, expired, expiringIn15Days: expiringSubs.length },
    pendingSignups,
    revenue: { thisMonth: Number(mRev._sum.amount ?? 0), thisYear: Number(yRev._sum.amount ?? 0) },
    branches,
    users,
  };
}

// ───────────── Sign-ups ─────────────

export async function listSignups(query: { page: number; pageSize: number; status?: 'PENDING' | 'APPROVED' | 'REJECTED' }): Promise<Paged<SignupRequestDto>> {
  const where = query.status ? { status: query.status } : {};
  const [rows, total] = await Promise.all([
    prisma.signupRequest.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.signupRequest.count({ where }),
  ]);
  const [states, districts] = await Promise.all([
    prisma.state.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.stateId))] } } }),
    prisma.district.findMany({ where: { id: { in: rows.map((r) => r.districtId).filter((x): x is number => x != null) } } }),
  ]);
  const sName = new Map(states.map((s) => [s.id, s.name]));
  const dName = new Map(districts.map((d) => [d.id, d.name]));
  return {
    items: rows.map((r) => signupDto(r, sName.get(r.stateId) ?? '', r.districtId != null ? (dName.get(r.districtId) ?? null) : null)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function approveSignup(superAdminId: number, signupId: number, body: { planId: number; owner: OwnerInput }): Promise<BusinessDetailDto> {
  const signup = await prisma.signupRequest.findUnique({ where: { id: signupId } });
  if (!signup) throw new HttpError(404, 'NOT_FOUND', 'Sign-up not found');
  if (signup.status !== 'PENDING') throw new HttpError(409, 'CONFLICT', 'Sign-up already reviewed');
  const business = await prisma.$transaction((tx) =>
    provisionBusiness(tx, {
      name: signup.shopName,
      ownerName: signup.ownerName,
      mobile: signup.whatsapp,
      email: signup.email ?? undefined,
      address: signup.address,
      stateId: signup.stateId,
      districtId: signup.districtId ?? undefined,
      owner: body.owner,
      planId: body.planId,
      createdById: superAdminId,
      signupId: signup.id,
      reviewedById: superAdminId,
    }),
  );
  return businessDetail(business.id);
}

export async function rejectSignup(superAdminId: number, signupId: number, reason: string): Promise<void> {
  const signup = await prisma.signupRequest.findUnique({ where: { id: signupId } });
  if (!signup) throw new HttpError(404, 'NOT_FOUND', 'Sign-up not found');
  if (signup.status !== 'PENDING') throw new HttpError(409, 'CONFLICT', 'Sign-up already reviewed');
  await prisma.signupRequest.update({ where: { id: signupId }, data: { status: 'REJECTED', rejectReason: reason, reviewedById: superAdminId, reviewedAt: new Date() } });
}

// ───────────── Businesses ─────────────

export async function listBusinesses(query: { page: number; pageSize: number; q?: string; status?: 'ACTIVE' | 'SUSPENDED'; subscription?: 'active' | 'expiring' | 'expired' }): Promise<Paged<BusinessListItemDto>> {
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * DAY);
  const where: Prisma.BusinessWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { ownerName: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.business.findMany({ where, include: { subscriptions: { orderBy: { endsAt: 'desc' }, take: 1, include: { plan: true } }, _count: { select: { branches: true, users: true } } }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.business.count({ where }),
  ]);
  let items = rows.map((b) => businessListItem(b, now, in15));
  // shortcut: subscription-state filter is applied per page (not pushed to SQL); upgrade if businesses grow large.
  if (query.subscription) items = items.filter((i) => i.subscriptionState === query.subscription);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function createBusiness(superAdminId: number, body: CreateBusinessInput): Promise<BusinessDetailDto> {
  const business = await prisma.$transaction((tx) =>
    provisionBusiness(tx, {
      name: body.name,
      ownerName: body.ownerName,
      mobile: body.mobile,
      alternateMobile: body.alternateMobile,
      email: body.email,
      gstin: body.gstin,
      address: body.address,
      stateId: body.stateId,
      districtId: body.districtId,
      rootBranchName: body.rootBranchName,
      owner: body.owner,
      planId: body.planId,
      createdById: superAdminId,
    }),
  );
  return businessDetail(business.id);
}

export async function businessDetail(businessId: number): Promise<BusinessDetailDto> {
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * DAY);
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      subscriptions: { orderBy: { endsAt: 'desc' }, include: { plan: true } },
      payments: { orderBy: { createdAt: 'desc' }, include: PAYMENT_INCLUDE },
      users: { where: { isOwner: true }, take: 1 },
      _count: { select: { branches: true, users: true } },
    },
  });
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Business not found');
  const [state, district] = await Promise.all([
    b.stateId != null ? prisma.state.findUnique({ where: { id: b.stateId } }) : null,
    b.districtId != null ? prisma.district.findUnique({ where: { id: b.districtId } }) : null,
  ]);
  const owner = b.users[0];
  return {
    ...businessListItem(b, now, in15),
    alternateMobile: b.alternateMobile,
    email: b.email,
    gstin: b.gstin,
    address: b.address,
    state: state ? { id: state.id, name: state.name } : null,
    district: district ? { id: district.id, name: district.name } : null,
    owner: owner ? { id: owner.id, name: owner.name, username: owner.username, mobile: owner.mobile, email: owner.email, lastLoginAt: owner.lastLoginAt ? owner.lastLoginAt.toISOString() : null } : null,
    subscriptions: b.subscriptions.map(subDto),
    payments: b.payments.map(paymentDto),
  };
}

export async function updateBusiness(businessId: number, body: Record<string, unknown> & { stateId?: number | null; districtId?: number | null }): Promise<BusinessDetailDto> {
  const current = await prisma.business.findUnique({ where: { id: businessId }, select: { stateId: true, districtId: true } });
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Business not found');
  await prisma.business.update({ where: { id: businessId }, data: { ...body, ...(await checkedGeo(body, current)) } });
  return businessDetail(businessId);
}

export async function setBusinessStatus(businessId: number, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
  await prisma.business.update({ where: { id: businessId }, data: { status } });
}

// ───────────── Plans ─────────────

export async function listPlans(): Promise<PlanDto[]> {
  const plans = await prisma.plan.findMany({ include: { _count: { select: { subscriptions: { where: { status: 'ACTIVE' } } } } }, orderBy: { price: 'asc' } });
  return plans.map(planDto);
}

export async function createPlan(body: PlanInput): Promise<PlanDto> {
  const plan = await prisma.plan.create({ data: { ...body, description: body.description ?? null } });
  return planDto({ ...plan, _count: { subscriptions: 0 } });
}

export async function updatePlan(planId: number, body: Partial<PlanInput>): Promise<PlanDto> {
  await prisma.plan.update({ where: { id: planId }, data: body });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId }, include: { _count: { select: { subscriptions: { where: { status: 'ACTIVE' } } } } } });
  return planDto(plan);
}

// ───────────── Subscriptions ─────────────

export async function assignSubscription(superAdminId: number, businessId: number, body: AssignSubscriptionInput): Promise<SubscriptionDto> {
  const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
  if (!plan) throw new HttpError(404, 'NOT_FOUND', 'Plan not found');
  return subDto(await createTerm(prisma, superAdminId, businessId, plan, body));
}

/** A new subscription term on `plan`; shared by assign and payment confirmation. */
async function createTerm(client: Prisma.TransactionClient, superAdminId: number, businessId: number, plan: { id: number; durationDays: number; maxBranches: number; maxUsers: number; modules: string[] }, body: Partial<AssignSubscriptionInput>) {
  const latest = await client.subscription.findFirst({ where: { businessId }, orderBy: { endsAt: 'desc' } });
  const now = new Date();
  // New term starts at the given date, or at the current end if still active, else now.
  const startsAt = body.startsAt ?? (latest && latest.endsAt > now ? latest.endsAt : now);
  const durationDays = body.durationDays ?? plan.durationDays;
  return client.subscription.create({
    data: {
      businessId,
      planId: plan.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationDays * DAY),
      maxBranches: body.maxBranches ?? plan.maxBranches,
      maxUsers: body.maxUsers ?? plan.maxUsers,
      modules: body.modules ?? plan.modules,
      notes: body.notes ?? null,
      createdById: superAdminId,
    },
    include: { plan: true },
  });
}

export async function updateSubscription(subscriptionId: number, body: UpdateSubscriptionInput): Promise<SubscriptionDto> {
  const sub = await prisma.subscription.update({ where: { id: subscriptionId }, data: body, include: { plan: true } });
  return subDto(sub);
}

// ───────────── Payments ─────────────

export async function listPayments(query: { page: number; pageSize: number }): Promise<Paged<PaymentDto>> {
  const [rows, total] = await Promise.all([
    prisma.subscriptionPayment.findMany({ include: PAYMENT_INCLUDE, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.subscriptionPayment.count(),
  ]);
  return { items: rows.map(paymentDto), total, page: query.page, pageSize: query.pageSize };
}

export async function recordPayment(businessId: number, body: RecordPaymentInput): Promise<PaymentDto> {
  const p = await prisma.subscriptionPayment.create({
    data: { businessId, subscriptionId: body.subscriptionId ?? null, amount: body.amount, method: body.method, utr: body.utr ?? null, status: body.status, paidAt: body.paidAt ?? (body.status === 'CONFIRMED' ? new Date() : null) },
    include: PAYMENT_INCLUDE,
  });
  return paymentDto(p);
}

/**
 * TASK-95: confirm or reject a PENDING payment exactly once (guarded update — a second decision is a 409).
 * G2b: confirming renews once, in the same transaction (a new term on the payment's plan; the payment then points at it)
 * when the payment says so (renewOnConfirm: submitted by the business after the flag existed) or the Super Admin decides
 * it explicitly (`renew`). Older payments never renew on their own — their term may already have been assigned by hand.
 */
export async function reviewPayment(superAdminId: number, paymentId: number, status: 'CONFIRMED' | 'REJECTED', renew?: boolean): Promise<PaymentDto> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.subscriptionPayment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: { status, ...(status === 'CONFIRMED' ? { paidAt: new Date() } : {}) },
    });
    if (count === 0) {
      const exists = await tx.subscriptionPayment.findUnique({ where: { id: paymentId }, select: { id: true } });
      throw exists ? new HttpError(409, 'CONFLICT', 'Payment already reviewed') : new HttpError(404, 'NOT_FOUND', 'Payment not found');
    }
    if (status !== 'CONFIRMED') return;
    const p = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (!(renew ?? p.renewOnConfirm)) return;
    if (p.planId == null) throw new HttpError(400, 'VALIDATION', 'This payment names no plan to renew — assign one by hand');
    // one renewal at a time per business, so two confirmations stack their terms instead of both starting at the same end
    await tx.$executeRaw`SELECT 1 FROM "Business" WHERE id = ${p.businessId} FOR UPDATE`;
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: p.planId } });
    const sub = await createTerm(tx, superAdminId, p.businessId, plan, { notes: `Renewed on payment #${p.id}${renew ? ' (explicit decision)' : ''}` });
    await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { subscriptionId: sub.id } });
  });
  return paymentDto(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId }, include: PAYMENT_INCLUDE }));
}

// ───────────── Impersonation ─────────────

export async function impersonate(superAdminId: number, businessId: number, reason: string, meta: { userAgent?: string | null; ip?: string | null }): Promise<LoginResponse> {
  const owner = await prisma.user.findFirst({ where: { businessId, isOwner: true } });
  if (!owner) throw new HttpError(404, 'NOT_FOUND', 'Business owner not found');
  await prisma.impersonationLog.create({ data: { superAdminId, businessId, targetUserId: owner.id, reason, ip: meta.ip ?? null } });
  const { randomBytes, createHash } = await import('node:crypto');
  const refreshToken = randomBytes(32).toString('base64url');
  const session = await prisma.session.create({
    data: { userId: owner.id, refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'), expiresAt: new Date(Date.now() + 30 * DAY), impersonatorId: superAdminId, userAgent: meta.userAgent ?? undefined, ip: meta.ip ?? undefined },
  });
  const accessToken = signAccessToken({ sub: owner.id, sid: session.id, imp: superAdminId });
  const user = await buildMe(owner.id, superAdminId);
  return { accessToken, user };
}

export async function endImpersonation(superAdminId: number): Promise<void> {
  await prisma.impersonationLog.updateMany({ where: { superAdminId, endedAt: null }, data: { endedAt: new Date() } });
}

// ───────────── Shared provisioning ─────────────

interface OwnerInput {
  name: string;
  username: string;
  password: string;
  mobile?: string;
  email?: string;
}
interface CreateBusinessInput {
  name: string;
  ownerName: string;
  mobile: string;
  alternateMobile?: string | null;
  email?: string;
  gstin?: string;
  address?: string;
  stateId?: number;
  districtId?: number;
  rootBranchName?: string;
  owner: OwnerInput;
  planId: number;
}
interface PlanInput {
  name: string;
  description?: string;
  durationDays: number;
  price: number;
  maxBranches: number;
  maxUsers: number;
  modules: string[];
  isActive: boolean;
}
interface AssignSubscriptionInput {
  planId: number;
  startsAt?: Date;
  durationDays?: number;
  maxBranches?: number;
  maxUsers?: number;
  modules?: string[];
  notes?: string;
}
interface UpdateSubscriptionInput {
  endsAt?: Date;
  status?: 'ACTIVE' | 'CANCELLED';
  maxBranches?: number;
  maxUsers?: number;
  modules?: string[];
  notes?: string;
}
interface RecordPaymentInput {
  amount: number;
  method: 'UPI' | 'CASH' | 'BANK' | 'GATEWAY';
  utr?: string;
  paidAt?: Date;
  subscriptionId?: number;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
}

async function provisionBusiness(
  tx: Prisma.TransactionClient,
  data: {
    name: string;
    ownerName: string;
    mobile: string;
    alternateMobile?: string | null;
    email?: string;
    gstin?: string;
    address?: string;
    stateId?: number | null;
    districtId?: number | null;
    rootBranchName?: string;
    owner: OwnerInput;
    planId: number;
    createdById: number;
    signupId?: number;
    reviewedById?: number;
  },
): Promise<{ id: number }> {
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: data.planId } });
  await checkedGeo({ stateId: data.stateId, districtId: data.districtId }); // create + signup approval
  const business = await tx.business.create({
    data: { name: data.name, ownerName: data.ownerName, mobile: data.mobile, alternateMobile: data.alternateMobile ?? null, email: data.email ?? null, gstin: data.gstin ?? null, address: data.address ?? null, stateId: data.stateId ?? null, districtId: data.districtId ?? null },
  });
  const root = await tx.branch.create({ data: { businessId: business.id, name: data.rootBranchName ?? data.name, isAdminNode: true, depth: 0, path: '' } });
  await tx.branch.update({ where: { id: root.id }, data: { path: `/${root.id}/` } });
  await tx.user.create({
    data: {
      level: 'ADMIN',
      businessId: business.id,
      branchId: root.id,
      isOwner: true,
      name: data.owner.name,
      username: data.owner.username,
      email: data.owner.email ?? null,
      mobile: data.owner.mobile ?? null,
      passwordHash: await argon2.hash(data.owner.password),
      createdById: data.createdById,
    },
  });
  const now = new Date();
  await tx.subscription.create({
    data: { businessId: business.id, planId: plan.id, startsAt: now, endsAt: new Date(now.getTime() + plan.durationDays * DAY), maxBranches: plan.maxBranches, maxUsers: plan.maxUsers, modules: plan.modules, createdById: data.createdById },
  });
  // Creation hook (docs/api-phase1.md): seed default karat mappings + rate limits.
  await ensureBusinessDefaults(tx, business.id);
  if (data.signupId) {
    await tx.signupRequest.update({ where: { id: data.signupId }, data: { status: 'APPROVED', businessId: business.id, reviewedById: data.reviewedById ?? null, reviewedAt: now } });
  }
  return business;
}

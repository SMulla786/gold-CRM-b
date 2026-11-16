import { prisma } from './prisma';
import { resolveAccess } from '../modules/auth/logic';
import type { MeDto } from '../shared';

/** Subscription-derived access for a business: active flag, read-only, enabled modules, plan limits. */
export interface AccessInfo {
  active: boolean;
  readOnly: boolean;
  modules: string[];
  subscription: MeDto['subscription'];
  /** Snapshot limits from the active subscription; null when no active subscription. */
  limits: { maxBranches: number; maxUsers: number } | null;
}

/** Single source of truth for subscription state — used by /auth/me and the request context so read-only never diverges. */
export async function loadAccess(businessId: number, status: 'ACTIVE' | 'SUSPENDED'): Promise<AccessInfo> {
  const now = new Date();
  const activeSub = await prisma.subscription.findFirst({
    where: { businessId, status: 'ACTIVE', endsAt: { gte: now } },
    orderBy: { endsAt: 'desc' },
    include: { plan: true },
  });
  const displaySub = activeSub ?? (await prisma.subscription.findFirst({ where: { businessId }, orderBy: { endsAt: 'desc' }, include: { plan: true } }));
  const active = !!activeSub && status === 'ACTIVE';
  // Ads: only the term in effect NOW (not the latest-ending or a queued one) and only its own snapshot — never the plan's price.
  const current = active
    ? await prisma.subscription.findFirst({ where: { businessId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { startsAt: 'desc' }, select: { adSupported: true } })
    : null;
  const { modules, subscription } = resolveAccess(
    active,
    displaySub ? { planName: displaySub.plan.name, endsAt: displaySub.endsAt, modules: displaySub.modules } : null,
    current?.adSupported === true,
  );
  return { active, readOnly: !active, modules, subscription, limits: activeSub ? { maxBranches: activeSub.maxBranches, maxUsers: activeSub.maxUsers } : null };
}

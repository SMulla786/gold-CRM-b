import { prisma } from './prisma';
import { HttpError } from '../middleware/error';
import type { TenantContext } from '../middleware/context';

/**
 * Tenant-scoped Prisma client. Services for tenant data MUST use scopedDb(req.ctx); raw `prisma` is only
 * for platform (SUPER_ADMIN) routes and auth. The extension injects businessId (and a branch/self filter)
 * into every query so a tenant filter can never be forgotten per the plan.
 *
 * IMPORTANT — the extension scopes the TOP-LEVEL model only. It does NOT scope nested connect/create or FK
 * writes. So every FK id that comes from client input (parentId, branchId, roleId, extraBranchIds, partyId…)
 * MUST first be resolved through scopedDb (e.g. scopedDb(ctx).branch.findUnique({where:{id}}) → 404 if null)
 * before it is written. Never take businessId from the request body — the extension overrides any client value.
 *
 * Relies on Prisma extendedWhereUnique: findUnique/update/delete accept extra scalar filters alongside the
 * unique field, so a cross-tenant lookup by id returns null (→ 404) and cross-tenant update/delete throws P2025.
 */

/**
 * business: businessId only (shared-at-business masters; branchId=0 = business-wide, handled in services).
 * branch:   businessId + branchId ∈ subtree (branch-owned rows).
 * self:     businessId + the row's own id ∈ subtree (the Branch tree itself).
 */
type Scope = 'business' | 'branch' | 'self';

const TENANT_MODELS: Record<string, Scope> = {
  Branch: 'self',
  Counter: 'branch',
  User: 'branch',
  Subscription: 'business',
  SubscriptionPayment: 'business',
  Party: 'business',
  BankAccount: 'business',
  Setting: 'business',
  KaratMapping: 'business',
  MetalRate: 'business',
  RateLimit: 'business',
  BusinessHsn: 'business',
};

const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);
const MULTI_WHERE_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'updateMany', 'updateManyAndReturn', 'deleteMany', 'count', 'aggregate', 'groupBy']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

export function scopedDb(ctx: TenantContext) {
  if (ctx.businessId == null) throw new Error('scopedDb requires a tenant context with a businessId');
  const businessId = ctx.businessId;
  const branchIds = ctx.branchIds;

  // Filter fields for MULTI ops and non-self UNIQUE ops (no key collision with a unique `id`).
  const filterFields = (scope: Scope): Record<string, unknown> =>
    scope === 'branch' ? { businessId, branchId: { in: branchIds } } : scope === 'self' ? { businessId, id: { in: branchIds } } : { businessId };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withBusiness = (d: any) => ({ ...d, businessId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assertCreateBranch = (scope: Scope, rows: any[]) => {
    if (scope !== 'branch') return;
    for (const r of rows) {
      if (r?.branchId != null && !branchIds.includes(r.branchId)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
  };

  return prisma.$extends({
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const scope = TENANT_MODELS[model];
          if (!scope) return query(args);
          const a = { ...(args ?? {}) };

          if (CREATE_OPS.has(operation)) {
            a.data = Array.isArray(a.data) ? a.data.map(withBusiness) : withBusiness(a.data);
            assertCreateBranch(scope, Array.isArray(a.data) ? a.data : [a.data]);
            return query(a);
          }
          if (operation === 'upsert') {
            if (scope === 'self') {
              if (typeof a.where?.id === 'number' && !branchIds.includes(a.where.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
              a.where = { ...a.where, businessId };
            } else {
              a.where = { ...a.where, ...filterFields(scope) };
            }
            a.create = withBusiness(a.create);
            assertCreateBranch(scope, [a.create]);
            return query(a);
          }
          if (UNIQUE_WHERE_OPS.has(operation)) {
            if (scope === 'self') {
              // Can't merge id:{in} next to the unique id, so short-circuit when the id isn't in the subtree.
              if (typeof a.where?.id === 'number' && !branchIds.includes(a.where.id)) {
                if (operation === 'findUnique') return null;
                throw new HttpError(404, 'NOT_FOUND', 'Not found');
              }
              a.where = { ...a.where, businessId };
            } else {
              a.where = { ...a.where, ...filterFields(scope) };
            }
            return query(a);
          }
          if (MULTI_WHERE_OPS.has(operation)) {
            a.where = a.where ? { AND: [a.where, filterFields(scope)] } : filterFields(scope);
            return query(a);
          }
          // Fail closed: an unhandled operation on a tenant model must never run unscoped.
          throw new HttpError(500, 'INTERNAL', `scopedDb: unhandled operation "${operation}" on tenant model ${model}`);
        },
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof scopedDb>;

/**
 * Idempotent seed: states, permission catalog, system roles, plans, super admin.
 * SEED_DEMO=true also creates a demo business with a small branch tree and users (password = SEED_SUPERADMIN_PASSWORD).
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { INDIAN_STATES, MODULES, MODULE_KEYS } from '../src/shared';

const prisma = new PrismaClient();
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

type Grant = { view: boolean; edit: boolean; delete: boolean };
const ALL: Grant = { view: true, edit: true, delete: true };
const VIEW: Grant = { view: true, edit: false, delete: false };
const EDIT: Grant = { view: true, edit: true, delete: false };

/** Default permission sets per system designation (seen in justudhari's designation list). */
const SYSTEM_ROLES: Record<string, (pageKey: string) => Grant | null> = {
  'Partner (Read Only)': () => VIEW,
  Partners: () => ALL,
  'Showroom Manager': (k) => (k.startsWith('settings.integration') ? VIEW : EDIT),
  'Stock Manager': (k) =>
    k.startsWith('inventory.') || k.startsWith('stock_summary.')
      ? ALL
      : k === 'dashboard.home' || k.startsWith('billing.') || k.startsWith('daybook.')
        ? VIEW
        : null,
  'Billing Operator / Cashier': (k) =>
    ['billing.sell_bill', 'billing.just_bill', 'billing.purchase_bill', 'udhari.entry', 'income_expense.entry', 'settings.parties'].includes(k)
      ? EDIT
      : ['dashboard.home', 'billing.gst_report', 'udhari.ledger', 'inventory.all_stock', 'daybook.all_in_one', 'daybook.money', 'income_expense.list'].includes(k)
        ? VIEW
        : null,
  'Sales Executive': (k) =>
    ['billing.showroom_drafts', 'orders.create', 'settings.parties'].includes(k)
      ? EDIT
      : ['dashboard.home', 'inventory.all_stock', 'inventory.dashboard', 'orders.list'].includes(k)
        ? VIEW
        : null,
};

async function seedStates() {
  for (const s of INDIAN_STATES) {
    await prisma.state.upsert({ where: { id: s.code }, update: { name: s.name }, create: { id: s.code, name: s.name } });
  }
}

async function seedPermissions() {
  let sort = 0;
  for (const m of MODULES) {
    await prisma.permission.upsert({
      where: { key: m.key },
      update: { label: m.label, sort: sort },
      create: { key: m.key, module: m.key, label: m.label, isModule: true, hasActions: false, sort: sort },
    });
    sort++;
    for (const pg of m.pages) {
      await prisma.permission.upsert({
        where: { key: pg.key },
        update: { label: pg.label, hasActions: pg.actions, sort: sort },
        create: { key: pg.key, module: m.key, label: pg.label, isModule: false, hasActions: pg.actions, sort: sort },
      });
      sort++;
    }
  }
}

async function seedSystemRoles() {
  const perms = await prisma.permission.findMany();
  const byKey = new Map(perms.map((x) => [x.key, x]));
  for (const [name, grantFor] of Object.entries(SYSTEM_ROLES)) {
    const existing = await prisma.role.findFirst({ where: { businessId: null, name } });
    const role = existing ?? (await prisma.role.create({ data: { name, isSystem: true } }));
    const rows: Prisma.RolePermissionCreateManyInput[] = [];
    for (const m of MODULES) {
      const pageRows = m.pages
        .map((pg) => ({ pg, g: grantFor(pg.key) }))
        .filter((x): x is { pg: (typeof m.pages)[number]; g: Grant } => x.g !== null);
      if (!pageRows.length) continue;
      rows.push({ roleId: role.id, permissionId: byKey.get(m.key)!.id, canView: true });
      for (const { pg, g } of pageRows) {
        rows.push({
          roleId: role.id,
          permissionId: byKey.get(pg.key)!.id,
          canView: g.view,
          canEdit: pg.actions && g.edit,
          canDelete: pg.actions && g.delete,
        });
      }
    }
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: rows });
  }
}

async function seedPlans() {
  const plans = [
    { name: 'Trial', description: '14-day free trial, all modules', durationDays: 14, price: 0, maxBranches: 2, maxUsers: 5, modules: MODULE_KEYS },
    {
      name: 'Basic (Yearly)',
      description: 'Billing, inventory, udhari, ledgers',
      durationDays: 365,
      price: 9999,
      maxBranches: 1,
      maxUsers: 5,
      modules: ['dashboard', 'settings', 'billing', 'inventory', 'udhari', 'income_expense', 'daybook'],
    },
    { name: 'Pro (Yearly)', description: 'All modules', durationDays: 365, price: 24999, maxBranches: 5, maxUsers: 25, modules: MODULE_KEYS },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({ where: { name: p.name }, update: {}, create: p });
  }
}

async function seedSuperAdmin(passwordHash: string) {
  const username = env('SEED_SUPERADMIN_USERNAME', 'superadmin');
  await prisma.user.upsert({
    where: { username },
    update: {},
    create: {
      level: 'SUPER_ADMIN',
      name: 'Platform Owner',
      username,
      email: process.env.SEED_SUPERADMIN_EMAIL || null,
      passwordHash,
    },
  });
}

/** Creates a branch and fills its materialised path (needs the generated id). */
async function createBranch(data: { businessId: number; name: string; parent?: { id: number; path: string; depth: number }; isAdminNode?: boolean }) {
  const b = await prisma.branch.create({
    data: {
      businessId: data.businessId,
      name: data.name,
      parentId: data.parent?.id ?? null,
      depth: data.parent ? data.parent.depth + 1 : 0,
      isAdminNode: data.isAdminNode ?? false,
      path: '',
    },
  });
  return prisma.branch.update({ where: { id: b.id }, data: { path: `${data.parent?.path ?? '/'}${b.id}/` } });
}

async function seedDemo(passwordHash: string) {
  if (await prisma.business.findFirst({ where: { name: 'Demo Jewellers' } })) return;
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: 'Pro (Yearly)' } });
  const biz = await prisma.business.create({
    data: { name: 'Demo Jewellers', ownerName: 'Demo Owner', mobile: '9000000001', stateId: 27 },
  });
  const now = new Date();
  await prisma.subscription.create({
    data: {
      businessId: biz.id,
      planId: plan.id,
      startsAt: now,
      endsAt: new Date(now.getTime() + plan.durationDays * 86400000),
      maxBranches: plan.maxBranches,
      maxUsers: plan.maxUsers,
      modules: plan.modules,
    },
  });
  const root = await createBranch({ businessId: biz.id, name: 'Demo HQ', isAdminNode: true });
  const pune = await createBranch({ businessId: biz.id, name: 'Pune', parent: root, isAdminNode: true });
  const kothrud = await createBranch({ businessId: biz.id, name: 'Kothrud', parent: pune });
  await createBranch({ businessId: biz.id, name: 'Mumbai', parent: root });
  const cashierRole = await prisma.role.findFirstOrThrow({ where: { businessId: null, name: 'Billing Operator / Cashier' } });
  const users = [
    { username: 'demo.owner', name: 'Demo Owner', level: 'ADMIN' as const, branchId: root.id, isOwner: true },
    { username: 'demo.pune', name: 'Pune Manager', level: 'ADMIN' as const, branchId: pune.id },
    { username: 'demo.cashier', name: 'Kothrud Cashier', level: 'BRANCH_USER' as const, branchId: kothrud.id, roleId: cashierRole.id },
  ];
  for (const u of users) {
    await prisma.user.create({ data: { ...u, businessId: biz.id, passwordHash } });
  }
}

async function main() {
  const passwordHash = await argon2.hash(env('SEED_SUPERADMIN_PASSWORD'));
  await seedStates();
  await seedPermissions();
  await seedSystemRoles();
  await seedPlans();
  await seedSuperAdmin(passwordHash);
  if (process.env.SEED_DEMO === 'true') await seedDemo(passwordHash);
  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

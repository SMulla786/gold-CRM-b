import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { billBody, deletePartyQuery, udharBody } from '../../shared';
import { errorHandler } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { createBill } from './billing/service';
import { deleteParty, PARTY_REFS } from './service';
import { createUdharTxn } from './udhar';

// photo cleanup deletes under UPLOAD_DIR: point it at a temp dir before src/config/env.ts is parsed
const UPLOADS = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
  return (process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'ju-party-delete-')));
});

// DELETE /app/parties/:id (owner rule, G6): dues or a pending bill → 409; any history → archived (isActive=false, rows
// untouched); no history → 409 CONFIRM_REQUIRED, hard delete only with ?confirm=true.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['udhari', 'billing'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(async () => {
  await rm(UPLOADS, { recursive: true, force: true });
  await db.$disconnect();
});

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  let seq = 0;
  const bill = (final: number, paid: number, over: Record<string, unknown> = {}) => {
    seq++;
    return db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: `B${seq}`, seq, partyId: party.id, billDate: new Date(), sub: final, taxable: final, total: final, final, paid, ...over } });
  };
  const udhar = (amount: number, gold = 0, silver = 0) =>
    db.udharEntry.create({ data: { businessId: business.id, branchId: root.id, partyId: party.id, txnDate: new Date(), amount, gold, silver, source: 'SELL_BILL', sourceId: 'x' } });
  return { ctx, business, root, party, bill, udhar };
}
const rowsOf = async (partyId: number) => ({
  bills: await db.bill.findMany({ where: { partyId }, select: { id: true, status: true, final: true, paid: true }, orderBy: { id: 'asc' } }),
  udhar: await db.udharEntry.findMany({ where: { partyId }, select: { id: true, amount: true }, orderBy: { id: 'asc' } }),
  ledger: await db.ledgerEntry.findMany({ where: { partyId }, select: { id: true, amount: true }, orderBy: { id: 'asc' } }),
});
const partyRow = (id: number) => db.party.findUnique({ where: { id } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** [status, code] the API would answer for an error a service threw (errorHandler is the only mapper). */
function httpStatus(err: unknown): [number, string] {
  let out: [number, string] = [0, ''];
  const res = { status: (n: number) => ({ json: (b: { error: { code: string } }) => void (out = [n, b.error.code]) }) };
  errorHandler(err, { method: 'POST', originalUrl: '/test', id: 'test' } as never, res as never, () => {});
  return out;
}
/** Rows in any PARTY_REFS column pointing at a missing party (must always be 0). */
async function orphanCount(): Promise<number> {
  const col = (c: string) => Prisma.raw(`"${c}"`);
  const per = PARTY_REFS.map(([t, c]) => Prisma.sql`SELECT count(*)::int AS n FROM ${col(t)} x WHERE x.${col(c)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Party" p WHERE p.id = x.${col(c)})`);
  const rows = await db.$queryRaw<{ n: number }[]>(Prisma.join(per, ' UNION ALL ', '', ''));
  return rows.reduce((a, r) => a + r.n, 0);
}
/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await sleep(30);
  }
  throw new Error('no connection ever blocked on the party row');
}
/** Fully paid ROUGH sell bill (₹60,000 cash): history, but no dues and nothing pending. */
const paidBill = (partyId: number) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 60000 }] });

describe('deleteParty', () => {
  it('outstanding dues in money, gold or silver → 409 PARTY_HAS_DUES; party stays active', async () => {
    for (const [amount, gold, silver] of [[500, 0, 0], [0, 1.5, 0], [0, 0, -20]]) {
      await truncateAll();
      const s = await setup();
      await s.udhar(amount!, gold, silver);
      await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 409, code: 'PARTY_HAS_DUES' });
      expect((await partyRow(s.party.id))?.isActive).toBe(true);
    }
  });

  it('a pending bill (ACTIVE, final ≠ paid) → 409 PARTY_HAS_PENDING_BILLS even with udhar settled; a deleted bill does not block', async () => {
    const s = await setup();
    await s.bill(1000, 400); // udhar for it netted to zero elsewhere: the bill alone must block
    await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 409, code: 'PARTY_HAS_PENDING_BILLS' });
    expect((await partyRow(s.party.id))?.isActive).toBe(true);

    await truncateAll();
    const t = await setup();
    await t.bill(1000, 0, { status: 'DELETED' });
    expect(await deleteParty(t.ctx, t.party.id)).toEqual({ result: 'ARCHIVED' }); // history, but nothing pending
  });

  it('settled history → ARCHIVED (also with confirm); bills, udhar and ledger rows untouched', async () => {
    const s = await setup();
    const b = await s.bill(1000, 1000);
    await s.udhar(1000);
    await s.udhar(-1000);
    await db.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, partyId: s.party.id, txnDate: new Date(), asset: 'MONEY', direction: 'IN', amount: 1000, source: 'SELL_BILL', sourceId: String(b.id) } });
    const before = await rowsOf(s.party.id);
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
    expect((await partyRow(s.party.id))?.isActive).toBe(false);
    expect(await rowsOf(s.party.id)).toEqual(before);
  });

  it('a family head (has members) is archived, never hard-deleted; the member keeps its parentId', async () => {
    const s = await setup();
    const son = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Son', mobile: '9000000009', countryCode: '+91', parentId: s.party.id } });
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
    expect(await partyRow(s.party.id)).toMatchObject({ isActive: false });
    expect(await partyRow(son.id)).toMatchObject({ parentId: s.party.id, isActive: true });
  });

  it('unused party: without confirm → 409 CONFIRM_REQUIRED and nothing changes; with confirm → gone', async () => {
    const s = await setup();
    await expect(deleteParty(s.ctx, s.party.id)).rejects.toMatchObject({ status: 409, code: 'CONFIRM_REQUIRED' });
    expect((await partyRow(s.party.id))?.isActive).toBe(true);
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'DELETED' });
    expect(await partyRow(s.party.id)).toBeNull();
    await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 404 });
  });

  it("tenant isolation: another business's party → 404 (even with confirm) and it is unchanged", async () => {
    const a = await setup('A');
    const b = await setup('B');
    await expect(deleteParty(a.ctx, b.party.id, true)).rejects.toMatchObject({ status: 404 });
    expect(await partyRow(b.party.id)).toMatchObject({ id: b.party.id, isActive: true });
  });

  it('deleting an archived party again: still ARCHIVED, never hard-deleted, rows unchanged', async () => {
    const s = await setup();
    await s.bill(500, 500);
    const before = await rowsOf(s.party.id);
    expect(await deleteParty(s.ctx, s.party.id)).toEqual({ result: 'ARCHIVED' });
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
    expect([(await partyRow(s.party.id))?.isActive, await rowsOf(s.party.id)]).toEqual([false, before]);
  });

  it('PARTY_REFS lists every party-id column in the schema, each a relation to Party with onDelete NoAction (parentId: SetNull)', () => {
    const inSchema = Prisma.dmmf.datamodel.models.flatMap((m) =>
      m.fields.filter((f) => /(^p|P)artyId$|^karigarId$/.test(f.name) || (m.name === 'Party' && f.name === 'parentId')).map((f) => `${m.name}.${f.name}`),
    );
    expect(PARTY_REFS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(inSchema.sort());
    // NoAction, never Restrict (23001 is not P2003) and never Prisma's implicit SetNull for optional relations
    const onDelete = Prisma.dmmf.datamodel.models.flatMap((m) =>
      m.fields.filter((f) => f.type === 'Party' && f.relationFromFields?.length).map((f) => `${m.name}.${f.relationFromFields!.join()}=${f.relationOnDelete}`),
    );
    expect(onDelete.sort()).toEqual(PARTY_REFS.map(([t, c]) => `${t}.${c}=${c === 'parentId' ? 'SetNull' : 'NoAction'}`).sort());
  });

  it('every PARTY_REFS column is a real FK to Party in the DB: ON DELETE NO ACTION, not deferrable (parentId: SET NULL)', async () => {
    const fks = await db.$queryRaw<{ ref: string }[]>`
      SELECT cl.relname || '.' || a.attname || '=' || c.confdeltype::text || CASE WHEN c.condeferrable THEN ' DEFERRABLE' ELSE '' END AS ref
      FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = '"Party"'::regclass`;
    expect(fks.map((r) => r.ref).sort()).toEqual(PARTY_REFS.map(([t, c]) => `${t}.${c}=${c === 'parentId' ? 'n' : 'a'}`).sort());
  });

  it('the DB refuses a party delete that bypasses deleteParty: P2003 → 409 CONFLICT', async () => {
    const s = await setup();
    await s.bill(100, 100);
    const err = await db.party.delete({ where: { id: s.party.id } }).catch((e: unknown) => e); // raw delete, no history check
    expect(err).toMatchObject({ code: 'P2003' });
    expect(httpStatus(err)).toEqual([409, 'CONFLICT']);
    expect(await partyRow(s.party.id)).toMatchObject({ isActive: true });
  });

  it('the FK refuses the delete mid-flight (a reference the history check cannot see) → deleteParty falls back to ARCHIVED', async () => {
    const s = await setup();
    await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS party_ref_probe (party_id int NOT NULL REFERENCES "Party"(id))');
    try {
      await db.$executeRaw`INSERT INTO party_ref_probe VALUES (${s.party.id})`; // outside PARTY_REFS
      expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
      expect(await partyRow(s.party.id)).toMatchObject({ isActive: false });
    } finally {
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS party_ref_probe');
    }
  });

  it('race, delete first: a bill whose party check passed before the delete committed is refused (P2003 → 409), no orphan', async () => {
    const s = await setup();
    let deleted!: () => void;
    const rowGone = new Promise<void>((r) => (deleted = r));
    const del = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "Party" WHERE id = ${s.party.id} FOR UPDATE`;
      await t.party.delete({ where: { id: s.party.id } });
      deleted();
      await lockWaiter(); // the bill insert is now blocked on the FK's FOR KEY SHARE
    });
    await rowGone; // deleted but not committed: the creator's party check still sees the row
    const made = createBill(s.ctx, paidBill(s.party.id)).catch((e: unknown) => e);
    await del;
    const err = await made;
    expect(err).toMatchObject({ code: 'P2003' });
    expect(httpStatus(err)).toEqual([409, 'CONFLICT']);
    expect([await partyRow(s.party.id), await db.bill.count(), await orphanCount()]).toEqual([null, 0, 0]);
  });

  it('race, bill first: deleteParty waits for the uncommitted bill, then sees it and archives', async () => {
    const s = await setup();
    let inserted!: () => void;
    const billIn = new Promise<void>((r) => (inserted = r));
    const hold = db.$transaction(async (t) => {
      await t.bill.create({ data: { businessId: s.business.id, branchId: s.root.id, kind: 'SELL', billType: 'ROUGH', billNo: 'R1', seq: 1, partyId: s.party.id, billDate: new Date(), sub: 100, taxable: 100, total: 100, final: 100, paid: 100 } });
      inserted();
      await lockWaiter(); // deleteParty is blocked on its FOR UPDATE
    });
    await billIn;
    const del = deleteParty(s.ctx, s.party.id, true);
    await hold;
    expect(await del).toEqual({ result: 'ARCHIVED' });
    expect([(await partyRow(s.party.id))?.isActive, await db.bill.count(), await orphanCount()]).toEqual([false, 1, 0]);
  });

  it.each([
    ['bill', (ctx: TenantContext, partyId: number) => createBill(ctx, paidBill(partyId))],
    ['udhar entry', (ctx: TenantContext, partyId: number) => createUdharTxn(ctx, udharBody.parse({ partyId, cashOut: 500 }))],
  ])('race x12: confirmed delete vs %s create, never an orphan, never a 500', async (name, create) => {
    const s = await setup();
    const tally: Record<string, number> = {};
    const outcome = (r: PromiseSettledResult<unknown>, ok: (v: unknown) => string) => (r.status === 'fulfilled' ? ok(r.value) : httpStatus(r.reason).join(' '));
    for (let i = 0; i < 12; i++) {
      const p = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: `Race ${i}`, mobile: '9000000100', countryCode: '+91' } });
      // stagger the delete so it lands before, during and after the creator's checks
      const [del, made] = await Promise.allSettled([sleep(i % 6).then(() => deleteParty(s.ctx, p.id, true)), create(s.ctx, p.id)]);
      const key = `delete ${outcome(del, (v) => (v as { result: string }).result)} / create ${outcome(made, () => 'OK')}`;
      tally[key] = (tally[key] ?? 0) + 1;
      for (const r of [del, made]) if (r.status === 'rejected') expect([404, 409], String(r.reason)).toContain(httpStatus(r.reason)[0]);
      if (await partyRow(p.id)) expect(made.status).toBe('fulfilled'); // not deleted: the create went through
      else expect([del.status === 'fulfilled' && (del.value as { result: string }).result, made.status]).toEqual(['DELETED', 'rejected']);
    }
    expect(await orphanCount()).toBe(0);
    console.info(`[party-delete race] ${name}: ${JSON.stringify(tally)}`);
  });

  it("hard delete removes only the party's own images, after commit; shared, foreign and traversal paths stay", async () => {
    const s = await setup();
    const b = s.business.id;
    const rel = { own: `${b}/parties/own.jpg`, logo: `${b}/parties/logo.png`, shared: `${b}/parties/shared.jpg`, stock: `${b}/stock/item.jpg`, sneaky: `${b}/parties/../stock/other.jpg`, kept: `${b}/parties/kept.jpg` };
    for (const r of Object.values(rel)) {
      await mkdir(path.dirname(path.join(UPLOADS, r)), { recursive: true });
      await writeFile(path.join(UPLOADS, r), 'x');
    }
    const on = (r: string) => existsSync(path.join(UPLOADS, r));
    const party = (name: string, photoUrl: string | null, shopLogoUrl: string | null = null) =>
      db.party.create({ data: { businessId: b, type: 'CUSTOMER', name, mobile: '9000000200', countryCode: '+91', photoUrl, shopLogoUrl } });

    const p1 = await party('P1', rel.own, rel.logo);
    const p2 = await party('P2', rel.shared, rel.stock);
    await party('Other', null, rel.shared); // shares p2's photo
    const p3 = await party('P3', rel.sneaky);
    for (const p of [p1, p2, p3]) expect(await deleteParty(s.ctx, p.id, true)).toEqual({ result: 'DELETED' });
    expect([on(rel.own), on(rel.logo)]).toEqual([false, false]);
    expect([on(rel.shared), on(rel.stock), on(rel.sneaky)]).toEqual([true, true, true]);

    // archived (has history): files untouched
    const p4 = await party('P4', rel.kept);
    await db.bill.create({ data: { businessId: b, branchId: s.root.id, kind: 'SELL', billType: 'ROUGH', billNo: 'K1', seq: 1, partyId: p4.id, billDate: new Date(), sub: 1, taxable: 1, total: 1, final: 1, paid: 1 } });
    expect(await deleteParty(s.ctx, p4.id, true)).toEqual({ result: 'ARCHIVED' });
    expect(on(rel.kept)).toBe(true);
  });

  it('query contract: confirm is true only for "true"', () => {
    expect([{}, { confirm: 'false' }, { confirm: 'true' }].map((q) => deletePartyQuery.parse(q).confirm)).toEqual([false, false, true]);
    expect(() => deletePartyQuery.parse({ confirm: 'yes' })).toThrow();
  });
});

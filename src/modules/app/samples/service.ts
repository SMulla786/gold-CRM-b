/**
 * TASK-98 — Samples / Tounch register: a physical-custody register of purity-test samples.
 * NO ledger posting anywhere here (a melt is posted through kacha processing); every change writes a SampleMovement + activity row.
 * Status flips follow the girvi/transfer pattern: scoped read → guarded updateMany (count must be 1, else 409) inside the tx.
 */
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import type {
  Paged,
  SampleAction,
  SampleDetailDto,
  SampleDto,
  SamplePickDto,
  SampleStatus,
  sampleBody,
  sampleIssueBody,
  sampleListQuery,
  sampleNoteBody,
  sampleSearchQuery,
  updateSampleBody,
} from '../../../shared';

type CreateBody = z.infer<typeof sampleBody>;
type UpdateBody = z.infer<typeof updateSampleBody>;
type IssueBody = z.infer<typeof sampleIssueBody>;
type NoteBody = z.infer<typeof sampleNoteBody>;
type ListQuery = z.infer<typeof sampleListQuery>;
type SearchQuery = z.infer<typeof sampleSearchQuery>;
type Ref = { id: number; name: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const wt = (v: unknown) => D(v).toFixed(3);
/** fine = gross × tounch / 100, 3 dp half-up */
export const defaultFine = (gross: Prisma.Decimal.Value, tounch: Prisma.Decimal.Value): Prisma.Decimal =>
  D(gross).times(D(tounch)).div(100).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

const EDITABLE: SampleStatus[] = ['IN_HAND', 'RETURNED'];
/** statuses a sample can be issued from */
const ISSUABLE: SampleStatus[] = ['IN_HAND', 'RETURNED'];

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for samples (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Client FK ids resolved through scopedDb before they are written (cross-tenant → 404); karigar must be a KARIGAR party. */
async function assertParties(ctx: TenantContext, partyId?: number | null, karigarId?: number | null): Promise<{ party: Ref | null; karigar: Ref | null }> {
  const sdb = scopedDb(ctx);
  let party: Ref | null = null;
  let karigar: Ref | null = null;
  if (partyId != null) {
    const p = await sdb.party.findUnique({ where: { id: partyId } });
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
    party = { id: p.id, name: p.name };
  }
  if (karigarId != null) {
    const k = await sdb.party.findUnique({ where: { id: karigarId } });
    if (!k) throw new HttpError(404, 'NOT_FOUND', 'Karigar not found');
    if (k.type !== 'KARIGAR') throw new HttpError(400, 'VALIDATION', 'That party is not a karigar');
    karigar = { id: k.id, name: k.name };
  }
  return { party, karigar };
}

async function findSample(ctx: TenantContext, id: number) {
  const s = await scopedDb(ctx).sample.findUnique({ where: { id } });
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Sample not found');
  return s;
}

/** Keyword → sample no. ("12" / "#12"), only when Int4-safe (a mobile number must never reach an Int column). */
function docNoOf(kw: string): number | null {
  const m = /^#?(\d+)$/.exec(kw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

/** q → sampleNo OR party/karigar name OR note. */
async function keywordWhere(ctx: TenantContext, q?: string): Promise<any> {
  const kw = q?.trim();
  if (!kw) return {};
  const ids = (await scopedDb(ctx).party.findMany({ where: { name: { contains: kw, mode: 'insensitive' } }, select: { id: true } })).map((p) => p.id);
  const no = docNoOf(kw);
  return {
    OR: [
      ...(no != null ? [{ sampleNo: no }] : []),
      ...(ids.length ? [{ partyId: { in: ids } }, { karigarId: { in: ids } }] : []),
      { note: { contains: kw, mode: 'insensitive' } },
    ],
  };
}

async function nameMaps(ctx: TenantContext, partyIds: (number | null)[], branchIds: number[]) {
  const pIds = [...new Set(partyIds.filter((x): x is number => x != null))];
  const bIds = [...new Set(branchIds)];
  const sdb = scopedDb(ctx);
  const [parties, branches] = await Promise.all([
    pIds.length ? sdb.party.findMany({ where: { id: { in: pIds } }, select: { id: true, name: true } }) : [],
    bIds.length ? sdb.branch.findMany({ where: { id: { in: bIds } }, select: { id: true, name: true } }) : [],
  ]);
  return { party: new Map(parties.map((p) => [p.id, p.name])), branch: new Map(branches.map((b) => [b.id, b.name])) };
}

const refOf = (id: number | null, names: Map<number, string>): Ref | null => (id != null ? { id, name: names.get(id) ?? '' } : null);

async function toDtos(ctx: TenantContext, rows: any[]): Promise<SampleDto[]> {
  const names = await nameMaps(ctx, rows.flatMap((r) => [r.partyId, r.karigarId]), rows.map((r) => r.branchId));
  return rows.map((s) => ({
    id: s.id, sampleNo: s.sampleNo, metal: s.metal, grossWt: wt(s.grossWt), tounchPercent: wt(s.tounchPercent), fine: wt(s.fine), status: s.status, note: s.note,
    party: refOf(s.partyId, names.party), karigar: refOf(s.karigarId, names.party), branch: { id: s.branchId, name: names.branch.get(s.branchId) ?? '' },
    karigarIssueId: s.karigarIssueId ?? null,
    createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
  }));
}

const movementRow = (sampleId: number, action: SampleAction, ctx: TenantContext, x: { partyId?: number | null; karigarId?: number | null; note?: string | null }) => ({
  sampleId, action, partyId: x.partyId ?? null, karigarId: x.karigarId ?? null, note: x.note ?? null, userId: ctx.userId,
});

// ───────────── create / edit ─────────────

export async function createSample(ctx: TenantContext, body: CreateBody): Promise<SampleDetailDto> {
  const branchId = activeBranch(ctx);
  const { party, karigar } = await assertParties(ctx, body.partyId, body.karigarId);
  const fine = body.fine != null ? D(body.fine) : defaultFine(body.grossWt, body.tounchPercent);

  const id = await prisma.$transaction(async (tx) => {
    const seq = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, 'SAMPLE', 2)
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const sampleNo = Number(seq[0]!.next) - 1;
    const s = await tx.sample.create({
      data: {
        businessId: ctx.businessId!, branchId, sampleNo, partyId: party?.id ?? null, karigarId: karigar?.id ?? null, metal: body.metal,
        grossWt: body.grossWt, tounchPercent: body.tounchPercent, fine, status: 'IN_HAND', note: body.note ?? null, createdById: ctx.userId,
      },
    });
    await tx.sampleMovement.create({ data: movementRow(s.id, 'CREATED', ctx, { partyId: s.partyId, karigarId: s.karigarId, note: body.note }) });
    await logActivity(tx, ctx, { module: 'SAMPLE', action: 'CREATED', entity: 'Sample', entityId: String(s.id), summary: `Sample #${sampleNo} ${body.metal} ${wt(body.grossWt)} g @ ${wt(body.tounchPercent)}%`, partyName: party?.name ?? karigar?.name ?? null });
    return s.id;
  });
  return getSample(ctx, id);
}

export async function updateSample(ctx: TenantContext, id: number, body: UpdateBody): Promise<SampleDetailDto> {
  const s = await findSample(ctx, id);
  if (!EDITABLE.includes(s.status as SampleStatus)) throw new HttpError(409, 'CONFLICT', `A ${s.status.toLowerCase().replace('_', ' ')} sample cannot be edited`);
  await assertParties(ctx, body.partyId, body.karigarId);
  const gross = body.grossWt ?? s.grossWt;
  const tounch = body.tounchPercent ?? s.tounchPercent;
  const recompute = body.grossWt != null || body.tounchPercent != null;
  const fine = body.fine != null ? D(body.fine) : recompute ? defaultFine(gross, tounch) : D(s.fine);
  const data: any = {
    ...(body.metal ? { metal: body.metal } : {}),
    grossWt: gross, tounchPercent: tounch, fine,
    ...(body.partyId !== undefined ? { partyId: body.partyId } : {}),
    ...(body.karigarId !== undefined ? { karigarId: body.karigarId } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
  };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.sample.updateMany({ where: { id, businessId: ctx.businessId!, status: { in: EDITABLE } }, data });
    if (count !== 1) throw new HttpError(409, 'CONFLICT', 'Sample changed concurrently — reload and retry');
    await tx.sampleMovement.create({ data: movementRow(id, 'EDITED', ctx, { partyId: body.partyId !== undefined ? body.partyId : s.partyId, karigarId: body.karigarId !== undefined ? body.karigarId : s.karigarId, note: body.note ?? null }) });
    await logActivity(tx, ctx, { module: 'SAMPLE', action: 'EDITED', entity: 'Sample', entityId: String(id), summary: `Sample #${s.sampleNo} edited`, meta: { before: { grossWt: wt(s.grossWt), tounchPercent: wt(s.tounchPercent), fine: wt(s.fine) }, after: { grossWt: wt(gross), tounchPercent: wt(tounch), fine: wt(fine) } } });
  });
  return getSample(ctx, id);
}

// ───────────── status changes (custody only) ─────────────

type FlipRow = { id: number; sampleNo: number; partyId: number | null; karigarId: number | null };
type FlipOpts = { partyId?: number | null; karigarId?: number | null; karigarIssueId?: number; note?: string | null; partyName?: string | null; conflict?: string };

/**
 * Tx-aware status flip for a sample already resolved through scopedDb: guarded updateMany on the expected current status
 * (+ business + branch scope; count must be 1, else 409 — the caller's tx rolls back) → SampleMovement → activity row.
 */
async function flipSampleTx(tx: Prisma.TransactionClient, ctx: TenantContext, s: FlipRow, from: SampleStatus[], to: SampleStatus, action: SampleAction, x: FlipOpts): Promise<void> {
  const assign = {
    ...(x.partyId != null ? { partyId: x.partyId } : {}),
    ...(x.karigarId != null ? { karigarId: x.karigarId } : {}),
    ...(x.karigarIssueId != null ? { karigarIssueId: x.karigarIssueId } : {}),
  };
  // guard on the expected current status so two concurrent flips can't both run
  const { count } = await tx.sample.updateMany({ where: { id: s.id, businessId: ctx.businessId!, branchId: { in: ctx.branchIds }, status: { in: from } }, data: { status: to, ...assign } });
  if (count !== 1) throw new HttpError(409, 'CONFLICT', x.conflict ?? 'Sample status changed concurrently — reload and retry');
  await tx.sampleMovement.create({ data: movementRow(s.id, action, ctx, { partyId: x.partyId ?? s.partyId, karigarId: x.karigarId ?? s.karigarId, note: x.note }) });
  await logActivity(tx, ctx, { module: 'SAMPLE', action: 'EDITED', entity: 'Sample', entityId: String(s.id), summary: `Sample #${s.sampleNo} ${action.toLowerCase()}${x.note ? ` — ${x.note}` : ''}`, partyName: x.partyName ?? null });
}

async function transition(
  ctx: TenantContext, id: number, from: SampleStatus[], to: SampleStatus, action: SampleAction,
  x: { partyId?: number | null; karigarId?: number | null; note?: string | null; partyName?: string | null },
): Promise<SampleDetailDto> {
  const s = await findSample(ctx, id);
  if (!from.includes(s.status as SampleStatus)) throw new HttpError(409, 'CONFLICT', `A ${s.status.toLowerCase().replace('_', ' ')} sample cannot be ${action.toLowerCase()}`);
  await prisma.$transaction((tx) => flipSampleTx(tx, ctx, s, from, to, action, x));
  return getSample(ctx, id);
}

/** Scoped read of the samples to hand over with a karigar issue (missing / other tenant / other branch → 404). Call before the tx. */
export async function findIssuableSamples(ctx: TenantContext, ids: number[]): Promise<FlipRow[]> {
  const u = [...new Set(ids)];
  if (!u.length) return [];
  const rows = await scopedDb(ctx).sample.findMany({ where: { id: { in: u } }, select: { id: true, sampleNo: true, partyId: true, karigarId: true }, orderBy: { sampleNo: 'asc' } });
  if (rows.length !== u.length) throw new HttpError(404, 'NOT_FOUND', 'Sample not found');
  return rows;
}

/**
 * Inside the karigar-issue tx: IN_HAND | RETURNED → ISSUED for each sample, karigarId = the issue's karigar, karigarIssueId = the issue.
 * Any sample no longer available → 409 'Sample #n is not available' and the caller's whole tx (the issue) rolls back.
 */
export async function issueSamplesToKarigarTx(
  tx: Prisma.TransactionClient, ctx: TenantContext, rows: FlipRow[],
  x: { karigarId: number; karigarName: string; karigarIssueId: number; issueNo: number },
): Promise<void> {
  for (const s of rows) {
    await flipSampleTx(tx, ctx, s, ISSUABLE, 'ISSUED', 'ISSUED', {
      karigarId: x.karigarId, karigarIssueId: x.karigarIssueId, note: `Karigar issue #${x.issueNo}`, partyName: x.karigarName,
      conflict: `Sample #${s.sampleNo} is not available`,
    });
  }
}

/** IN_HAND | RETURNED → ISSUED. Given party/karigar replace the sample's. */
export async function issueSample(ctx: TenantContext, id: number, body: IssueBody): Promise<SampleDetailDto> {
  const { party, karigar } = await assertParties(ctx, body.partyId, body.karigarId);
  return transition(ctx, id, ISSUABLE, 'ISSUED', 'ISSUED', { partyId: party?.id, karigarId: karigar?.id, note: body.note, partyName: karigar?.name ?? party?.name ?? null });
}

/** ISSUED → RETURNED */
export async function returnSample(ctx: TenantContext, id: number, body: NoteBody): Promise<SampleDetailDto> {
  return transition(ctx, id, ['ISSUED'], 'RETURNED', 'RETURNED', { note: body.note });
}

/** any non-MELTED → MELTED (terminal; status flip only — the melt itself posts through kacha processing). */
export async function meltSample(ctx: TenantContext, id: number, body: NoteBody): Promise<SampleDetailDto> {
  return transition(ctx, id, ['IN_HAND', 'ISSUED', 'RETURNED'], 'MELTED', 'MELTED', { note: body.note });
}

// ───────────── reads ─────────────

export async function getSample(ctx: TenantContext, id: number): Promise<SampleDetailDto> {
  const s = await findSample(ctx, id);
  // movements reached through the scoped parent just loaded
  const moves = await prisma.sampleMovement.findMany({ where: { sampleId: s.id }, orderBy: { id: 'asc' } });
  const userIds = [...new Set(moves.map((m) => m.userId).filter((x): x is number => x != null))];
  const [names, users] = await Promise.all([
    nameMaps(ctx, [s.partyId, s.karigarId, ...moves.flatMap((m) => [m.partyId, m.karigarId])], [s.branchId]),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const [dto] = await toDtos(ctx, [s]);
  return {
    ...dto!,
    movements: moves.map((m) => ({
      id: m.id, action: m.action as SampleAction, party: refOf(m.partyId, names.party), karigar: refOf(m.karigarId, names.party), note: m.note,
      user: m.userId != null ? (userName.get(m.userId) ?? null) : null, createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function listSamples(ctx: TenantContext, q: ListQuery): Promise<Paged<SampleDto>> {
  const sdb = scopedDb(ctx);
  const where: any = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.metal ? { metal: q.metal } : {}),
    ...(q.partyId ? { partyId: q.partyId } : {}),
    ...(q.karigarId ? { karigarId: q.karigarId } : {}),
    ...(await keywordWhere(ctx, q.q)),
  };
  const [rows, total] = await Promise.all([
    sdb.sample.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    sdb.sample.count({ where }),
  ]);
  return { items: await toDtos(ctx, rows), total, page: q.page, pageSize: q.pageSize };
}

/** Light list for the SamplePicker (default IN_HAND + RETURNED, newest first). */
export async function searchSamples(ctx: TenantContext, q: SearchQuery): Promise<SamplePickDto[]> {
  const statuses = q.statuses?.length ? q.statuses : EDITABLE;
  const where: any = { status: { in: statuses }, ...(q.metal ? { metal: q.metal } : {}), ...(await keywordWhere(ctx, q.q)) };
  const rows = await scopedDb(ctx).sample.findMany({ where, orderBy: { id: 'desc' }, take: q.limit });
  return (await toDtos(ctx, rows)).map(({ id, sampleNo, metal, grossWt, tounchPercent, fine, status, party, karigar }) => ({ id, sampleNo, metal, grossWt, tounchPercent, fine, status, party, karigar }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

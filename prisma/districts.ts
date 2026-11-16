/**
 * G7 review 2: India-wide district master from the Local Government Directory (LGD), Government of India.
 * Source, checksums and the update procedure: prisma/data/README.md.
 *
 * Idempotent: a district is matched by its LGD code, else (rows made before this import) by state + name, ignoring
 * case. A match is updated in place, so its id — and every branch / party / business / sign-up pointing at it — stays.
 * Nothing is ever deleted: a district the source no longer lists is kept and reported with its reference count.
 * An LGD code match always wins over a name match (one district is never updated twice). A district whose code moved to
 * another state is reported (movedState) with its reference count; references are never rewritten — review them by hand.
 */
import { readFileSync } from 'node:fs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { parseCsv } from '../src/lib/csv';
import { INDIAN_STATES } from '../src/shared';

export const LGD_DISTRICTS_CSV = new URL('./data/lgd-districts.csv', import.meta.url);

export interface DistrictImportReport {
  sourceRows: number;
  created: number;
  updated: { id: number; from: string; to: string }[];
  unchanged: number;
  /** in the DB but not in the source: kept, never deleted */
  notInSource: { id: number; stateId: number; name: string; references: number }[];
  /** matched by LGD code but now in another state: updated in place; the branches / parties / businesses / sign-ups on it keep
   *  their stored state (never rewritten) — review those before --apply */
  movedState: { id: number; name: string; lgdCode: number; fromStateId: number; toStateId: number; references: number }[];
  /** a source row whose state + name matches a district another LGD code already owns: never overwrites that district; it is
   *  created as a district of its own (created: true), or reported only when the name stays taken (created: false) */
  nameTaken: { lgdCode: number; stateId: number; name: string; districtId: number; created: boolean }[];
}

export async function importDistricts(db: PrismaClient, opts: { apply: boolean; csv?: string }): Promise<DistrictImportReport> {
  const [header, ...rows] = parseCsv(opts.csv ?? readFileSync(LGD_DISTRICTS_CSV, 'utf8'));
  const col = (h: string): number => {
    const i = header!.indexOf(h);
    if (i < 0) throw new Error(`LGD CSV: column "${h}" missing — the LGD export format changed, check prisma/data/README.md`);
    return i;
  };
  const [cState, cCode, cName] = [col('State Name (In English)'), col('District Code'), col('District Name(In English)')];
  // LGD state codes are not GST codes (Andhra Pradesh: LGD 28, GST 37): map by name onto State.id = GST code
  const gstByName = new Map(INDIAN_STATES.map((s) => [s.name, s.code]));
  const source = rows.map((r) => {
    const stateId = gstByName.get(r[cState]!.trim().toUpperCase());
    if (stateId == null) throw new Error(`LGD CSV: state "${r[cState]}" has no GST state code in src/shared/geo.ts`);
    const lgdCode = Number(r[cCode]);
    if (!Number.isInteger(lgdCode) || lgdCode <= 0) throw new Error(`LGD CSV: bad district code "${r[cCode]}"`);
    const name = r[cName]!.trim();
    if (!name) throw new Error(`LGD CSV: district ${lgdCode} has no name`);
    return { stateId, lgdCode, name };
  });

  const existing = await db.district.findMany({ include: { _count: { select: { branches: true, parties: true, businesses: true, signupRequests: true } } } });
  const references = (d: (typeof existing)[number]) => d._count.branches + d._count.parties + d._count.businesses + d._count.signupRequests;
  const nameKey = (stateId: number, name: string) => `${stateId}:${name.toLowerCase()}`;
  const byCode = new Map(existing.filter((d) => d.lgdCode != null).map((d) => [d.lgdCode!, d]));
  const byName = new Map(existing.map((d) => [nameKey(d.stateId, d.name), d]));
  const report: DistrictImportReport = { sourceRows: source.length, created: 0, updated: [], unchanged: 0, notInSource: [], movedState: [], nameTaken: [] };
  // G7 closure: an LGD code match always wins — those districts are claimed first, so a row that only matches one of them by
  // name (before or after it in the file) can never overwrite it, and the code's own district is never lost
  const seen = new Set(source.flatMap((s) => (byCode.has(s.lgdCode) ? [byCode.get(s.lgdCode)!.id] : [])));
  const nameOwner = new Map(existing.map((d) => [nameKey(d.stateId, d.name), d.id])); // (state, name) → district, as after the updates
  const updates: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];
  const toCreate: typeof source = [];
  for (const s of source) {
    let d = byCode.get(s.lgdCode);
    if (!d) {
      const named = byName.get(nameKey(s.stateId, s.name));
      if (named && !seen.has(named.id)) {
        d = named;
        seen.add(named.id);
      } else if (named) report.nameTaken.push({ lgdCode: s.lgdCode, stateId: s.stateId, name: s.name, districtId: named.id, created: false });
    }
    if (!d) {
      toCreate.push(s);
      continue;
    }
    if (d.name === s.name && d.stateId === s.stateId && d.lgdCode === s.lgdCode) {
      report.unchanged++;
      continue;
    }
    report.updated.push({ id: d.id, from: `${d.stateId}:${d.name}`, to: `${s.stateId}:${s.name}` });
    if (d.stateId !== s.stateId) report.movedState.push({ id: d.id, name: s.name, lgdCode: s.lgdCode, fromStateId: d.stateId, toStateId: s.stateId, references: references(d) });
    if (nameOwner.get(nameKey(d.stateId, d.name)) === d.id) nameOwner.delete(nameKey(d.stateId, d.name));
    nameOwner.set(nameKey(s.stateId, s.name), d.id);
    const id = d.id;
    updates.push((tx) => tx.district.update({ where: { id }, data: s }));
  }
  const creates: typeof updates = [];
  for (const s of toCreate) {
    const taken = report.nameTaken.find((t) => t.lgdCode === s.lgdCode);
    const owner = nameOwner.get(nameKey(s.stateId, s.name));
    if (owner != null) {
      // the name is still a district's after the updates: creating it would break the (state, name) uniqueness — report only
      if (!taken) report.nameTaken.push({ lgdCode: s.lgdCode, stateId: s.stateId, name: s.name, districtId: owner, created: false });
      continue;
    }
    if (taken) taken.created = true;
    nameOwner.set(nameKey(s.stateId, s.name), -1);
    report.created++;
    creates.push((tx) => tx.district.create({ data: s }));
  }
  for (const d of existing) if (!seen.has(d.id)) report.notInSource.push({ id: d.id, stateId: d.stateId, name: d.name, references: references(d) });
  // updates before creates: a renamed district frees its old name for the new one. shortcut: one write per row (790 today) —
  // fine for a master this size; batch with createMany if LGD grows 10x
  const writes = [...updates, ...creates];
  if (opts.apply && writes.length) await db.$transaction(async (tx) => { for (const w of writes) await w(tx); }, { timeout: 120_000 });
  return report;
}

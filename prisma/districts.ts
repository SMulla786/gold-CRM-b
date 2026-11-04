/**
 * G7 review 2: India-wide district master from the Local Government Directory (LGD), Government of India.
 * Source, checksums and the update procedure: prisma/data/README.md.
 *
 * Idempotent: a district is matched by its LGD code, else (rows made before this import) by state + name, ignoring
 * case. A match is updated in place, so its id — and every branch / party / business / sign-up pointing at it — stays.
 * Nothing is ever deleted: a district the source no longer lists is kept and reported with its reference count.
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
  const byCode = new Map(existing.filter((d) => d.lgdCode != null).map((d) => [d.lgdCode!, d]));
  const byName = new Map(existing.map((d) => [`${d.stateId}:${d.name.toLowerCase()}`, d]));
  const report: DistrictImportReport = { sourceRows: source.length, created: 0, updated: [], unchanged: 0, notInSource: [] };
  const seen = new Set<number>();
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];
  for (const s of source) {
    const d = byCode.get(s.lgdCode) ?? byName.get(`${s.stateId}:${s.name.toLowerCase()}`);
    if (!d) {
      report.created++;
      writes.push((tx) => tx.district.create({ data: s }));
      continue;
    }
    seen.add(d.id);
    if (d.name === s.name && d.stateId === s.stateId && d.lgdCode === s.lgdCode) {
      report.unchanged++;
      continue;
    }
    report.updated.push({ id: d.id, from: `${d.stateId}:${d.name}`, to: `${s.stateId}:${s.name}` });
    writes.push((tx) => tx.district.update({ where: { id: d.id }, data: s }));
  }
  for (const d of existing) {
    const c = d._count;
    if (!seen.has(d.id)) report.notInSource.push({ id: d.id, stateId: d.stateId, name: d.name, references: c.branches + c.parties + c.businesses + c.signupRequests });
  }
  // shortcut: one write per row (790 today) — fine for a master this size; batch with createMany if LGD grows 10x
  if (opts.apply && writes.length) await db.$transaction(async (tx) => { for (const w of writes) await w(tx); }, { timeout: 120_000 });
  return report;
}

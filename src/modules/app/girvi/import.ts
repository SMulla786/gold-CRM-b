/**
 * Phase 9b — girvi bulk import. CSV rows (one per pledged item) are grouped by loan_ref into loans, each validated with the
 * same shared girviBody as the New Girvi form; customers are matched by mobile or created. A real import runs only when
 * every loan is valid, and then goes through createGirvi, so ledger postings and numbering are identical to manual entry.
 */
import { parseCsv } from '../../../lib/csv';
import { scopedDb } from '../../../lib/db';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import { GIRVI_IMPORT_COLUMNS, girviBody, partyBody } from '../../../shared';
import type { GirviImportLoanDto, GirviImportResultDto } from '../../../shared';
import { createParty } from '../service';
import { createGirvi } from './service';

const MAX_ROWS = 2000;

export function girviImportSampleCsv(): string {
  return [
    GIRVI_IMPORT_COLUMNS.join(','),
    'L1,Ramesh Patil,9876543210,Pune,2026-01-15,12,2,MONTHLY,SI,,DAY_WISE,50000,50000,0,Gold,Chain,20.000,19.500,91.6,6500,old loan',
    'L1,Ramesh Patil,9876543210,Pune,2026-01-15,12,2,MONTHLY,SI,,DAY_WISE,50000,50000,0,Gold,Ring,5.000,4.800,91.6,6500,',
    'L2,Sunita Shah,9123456780,,2026-02-01,6,1.5,MONTHLY,CI,MONTHLY,FULL_MONTH,30000,0,30000,Silver,Payal,250.000,240.000,92.5,80,',
  ].join('\n');
}

export async function importGirvi(ctx: TenantContext, csv: string, opts: { dryRun: boolean; bankAccountId?: number }): Promise<GirviImportResultDto> {
  const table = parseCsv(csv);
  if (table.length < 2) throw new HttpError(400, 'VALIDATION', 'The CSV has no data rows');
  if (table.length - 1 > MAX_ROWS) throw new HttpError(400, 'VALIDATION', `The CSV exceeds ${MAX_ROWS} rows`);
  const header = table[0]!.map((h) => h.toLowerCase());
  const missing = GIRVI_IMPORT_COLUMNS.filter((c) => !['address', 'ci_period', 'remark'].includes(c) && !header.includes(c));
  if (missing.length) throw new HttpError(400, 'VALIDATION', `Missing columns: ${missing.join(', ')}`);
  const cell = (r: string[], name: string) => r[header.indexOf(name)] ?? '';

  // group rows by loan_ref, keeping file order
  const groups = new Map<string, { row: number; cells: string[] }[]>();
  table.slice(1).forEach((cells, i) => {
    const ref = cell(cells, 'loan_ref') || `row-${i + 2}`;
    groups.set(ref, [...(groups.get(ref) ?? []), { row: i + 2, cells }]);
  });

  const sdb = scopedDb(ctx);
  const loans: (GirviImportLoanDto & { body?: unknown; partyId?: number; party?: unknown })[] = [];
  for (const [loanRef, rows] of groups) {
    const first = rows[0]!;
    const c = (name: string) => cell(first.cells, name);
    const errors: GirviImportLoanDto['errors'] = [];
    const party = partyBody.pick({ name: true, mobile: true, address: true }).safeParse({ name: c('customer_name'), mobile: c('mobile'), address: c('address') || undefined });
    if (!party.success) for (const is of party.error.issues) errors.push({ row: first.row, field: String(is.path[0] ?? ''), message: is.message });
    // every row of a loan must repeat the same customer + terms
    for (const r of rows.slice(1)) {
      for (const k of ['mobile', 'issue_date', 'principal', 'rate_percent']) {
        if (cell(r.cells, k) !== c(k)) errors.push({ row: r.row, field: k, message: `Differs from row ${first.row} of loan ${loanRef}` });
      }
    }
    const raw = {
      partyId: 1, // placeholder for validation; the real id is resolved below
      issueDate: c('issue_date') || undefined,
      items: rows.map((r) => ({ category: cell(r.cells, 'item_category'), name: cell(r.cells, 'item_name'), gross: cell(r.cells, 'gross'), net: cell(r.cells, 'net'), purity: cell(r.cells, 'purity'), rate: cell(r.cells, 'rate') })),
      principal: c('principal'),
      ratePercent: c('rate_percent'),
      ratePeriod: c('rate_period').toUpperCase(),
      interestType: c('interest_type').toUpperCase(),
      ciPeriod: c('ci_period') ? c('ci_period').toUpperCase() : undefined,
      method: c('method').toUpperCase() || 'DAY_WISE',
      tenureMonths: c('tenure_months'),
      remark: c('remark') || undefined,
      cash: c('cash') || 0,
      online: c('online') || 0,
      bankAccountId: opts.bankAccountId,
    };
    const parsed = girviBody.safeParse(raw);
    if (!parsed.success) {
      for (const is of parsed.error.issues) {
        const itemIdx = is.path[0] === 'items' && typeof is.path[1] === 'number' ? is.path[1] : null;
        errors.push({ row: itemIdx != null ? rows[itemIdx]!.row : first.row, field: is.path.filter((p) => typeof p === 'string').join('.'), message: is.message });
      }
    }
    const valuation = parsed.success ? parsed.data.items.reduce((a, it) => a + (it.net * it.purity) / 100 * it.rate, 0) : 0;
    if (parsed.success && parsed.data.principal > valuation + 0.005) errors.push({ row: first.row, field: 'principal', message: 'Loan exceeds the item valuation' });
    const existing = party.success ? await sdb.party.findFirst({ where: { mobile: party.data.mobile, type: 'CUSTOMER' } }) : null;
    loans.push({
      loanRef, row: first.row, customer: c('customer_name'), mobile: c('mobile'), existingCustomer: !!existing, issueDate: c('issue_date'), items: rows.length,
      valuation: valuation.toFixed(2), principal: c('principal'), girviNo: null, errors,
      body: parsed.success ? parsed.data : undefined, partyId: existing?.id, party: party.success ? party.data : undefined,
    });
  }

  const valid = loans.filter((l) => l.errors.length === 0).length;
  const strip = (l: (typeof loans)[number]): GirviImportLoanDto => ({ loanRef: l.loanRef, row: l.row, customer: l.customer, mobile: l.mobile, existingCustomer: l.existingCustomer, issueDate: l.issueDate, items: l.items, valuation: l.valuation, principal: l.principal, girviNo: l.girviNo, errors: l.errors });
  if (opts.dryRun || valid !== loans.length) return { dryRun: opts.dryRun, loans: loans.map(strip), valid, imported: 0 };

  // shortcut: each loan commits in its own transaction (via createGirvi); a failure part-way reports what was imported — upgrade to one batch tx if shops need all-or-nothing.
  let imported = 0;
  for (const l of loans) {
    try {
      const partyId = l.partyId ?? (await createParty(ctx, { type: 'CUSTOMER', countryCode: '+91', ...(l.party as object) })).dto.id;
      const batch = await createGirvi(ctx, { ...(l.body as Parameters<typeof createGirvi>[1]), partyId });
      l.girviNo = batch.girviNo;
      imported++;
    } catch (e) {
      l.errors.push({ row: l.row, message: e instanceof Error ? e.message : 'Import failed' });
      break;
    }
  }
  return { dryRun: false, loans: loans.map(strip), valid, imported };
}

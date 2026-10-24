// Runs every case captured from justudhari's own calc functions (TASK-10) through our engine.
// Exact match for weights, line totals, subtotal and GST split; ±₹0.01 on total/round-off because
// justudhari uses JS floats (e.g. 4645.815 renders as 4645.81) while we use exact decimals; likewise
// fine ±0.001 g (15 × 0.9167 = 13.7505 exactly → we round to 13.751, the app's float shows 13.750).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBill, computeLine, type DiscountUnit, type LabourUnit } from './index';

interface FixtureInput {
  name: string;
  metal: 'gold' | 'silver';
  caret?: string;
  tunch?: number;
  pcs?: number;
  gross: number;
  less?: number;
  wstg?: number;
  chrg?: number;
  rate: number;
  lbr?: number;
  lbrunit?: 'r' | 'w' | 'p';
  other?: number;
  disc?: number;
  discunit?: 'r' | 'p';
  bill_type: 'g' | 'e';
  bill_disc?: number;
  bill_disc_unit?: 'r' | 'p';
  gst?: number;
}
interface Fixture {
  input: FixtureInput;
  output: Record<string, string>;
}

const file = join(import.meta.dirname, '__fixtures__', 'justudhari-cases.json');
const data = JSON.parse(readFileSync(file, 'utf8')) as { sell: Fixture[]; purchase: Fixture[]; _meta: { settings: { caret_to_tunch_pct: Record<string, number> } } };
const caretTunch = data._meta.settings.caret_to_tunch_pct;

const LABOUR: Record<string, LabourUnit> = { r: 'FIXED', w: 'PER_GRAM', p: 'PERCENT' };
const DISC: Record<string, DiscountUnit> = { r: 'FIXED', p: 'PERCENT' };

function run(kind: 'sell' | 'purchase', i: FixtureInput) {
  const rateUnitGrams = kind === 'purchase' ? 1 : i.metal === 'gold' ? 10 : 1000;
  const line = computeLine({
    gross: i.gross,
    less: i.less,
    tunch: i.tunch ?? (i.caret ? caretTunch[i.caret] : 100),
    wastage: i.wstg,
    stoneCharge: i.chrg,
    rate: i.rate,
    rateUnitGrams,
    labour: i.lbr,
    labourUnit: i.lbrunit ? LABOUR[i.lbrunit] : undefined,
    other: i.other,
    discount: i.disc,
    discountUnit: i.discunit ? DISC[i.discunit] : undefined,
  });
  const bill = computeBill({
    lineTotals: [line.total],
    discount: i.bill_disc,
    discountUnit: i.bill_disc_unit ? DISC[i.bill_disc_unit] : undefined,
    gstPercent: i.gst,
  });
  return { line, bill };
}

const near = (actual: string, expected: string, tol = 0.0100001) =>
  expect(Math.abs(Number(actual) - Number(expected))).toBeLessThanOrEqual(tol);

for (const kind of ['sell', 'purchase'] as const) {
  describe(`justudhari ${kind} fixtures`, () => {
    for (const { input, output } of data[kind]) {
      it(input.name, () => {
        const { line, bill } = run(kind, input);
        expect(line.net).toBe(output.net);
        near(line.fine, output.fine!, 0.0010001);
        expect(line.total).toBe(output.ttl);
        expect(bill.sub).toBe(output.sub);
        if (output.cgst_val) {
          expect(bill.cgst).toBe(output.cgst_val);
          expect(bill.sgst).toBe(output.sgst_val);
        }
        near(bill.total, output.total!);
        near(bill.round, output.round!);
        expect(Number(bill.final)).toBe(Number(output.final));
      });
    }
  });
}

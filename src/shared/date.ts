/**
 * The shop's business day is the IST calendar day — same rule as backend lib/ledger businessDate().
 * Never use `new Date().toISOString().slice(0, 10)` for "today": that is the UTC day, which is still
 * yesterday between 00:00 and 05:30 IST (BUG-17).
 */
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' of the IST business day for `d` (default: now). */
export const businessDayISO = (d: Date = new Date()): string => IST_DAY.format(d);

/** ISO timestamp in IST, e.g. '2026-10-27T01:30:00.000+05:30' (IST has no DST, so a fixed offset is exact). */
export const istTimestamp = (d: Date = new Date()): string => new Date(d.getTime() + 330 * 60000).toISOString().replace('Z', '+05:30');

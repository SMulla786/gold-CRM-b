/** Minimal CSV parser: handles quoted fields + escaped quotes; no embedded newlines inside quotes. Cells are trimmed; blank lines dropped. */
export function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out.map((c) => c.trim());
    });
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader — vitest does not honour node's --env-file. Never overrides an already-set var. */
export function loadDotenv(dir = process.cwd()): void {
  try {
    const txt = readFileSync(resolve(dir, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, raw = ''] = m;
      if (key && process.env[key] === undefined) {
        process.env[key] = raw.trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env yet — fine, caller provides fallbacks */
  }
}

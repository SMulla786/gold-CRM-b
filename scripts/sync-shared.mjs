// Copies backend/src/shared (source of truth) into the frontend repo as a read-only mirror.
// Usage: npm run sync:shared   (FRONTEND_DIR overrides the default ../frontend)
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(backend, 'src', 'shared');
const frontend = resolve(process.env.FRONTEND_DIR ?? join(backend, '..', 'frontend'));
const dest = join(frontend, 'src', 'shared');
const HEADER = '// GENERATED — do not edit. Source of truth: backend/src/shared (run `npm run sync:shared` in backend).\n';

if (!existsSync(join(frontend, 'package.json'))) {
  console.error(`Frontend repo not found at ${frontend}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (p) => !/\.test\.ts$|__fixtures__/.test(p) });

const stamp = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) stamp(p);
    else if (p.endsWith('.ts')) writeFileSync(p, HEADER + readFileSync(p, 'utf8'));
  }
};
stamp(dest);
console.log(`Synced shared -> ${dest}`);

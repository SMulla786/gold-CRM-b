import { execSync } from 'node:child_process';
import { closeSync, openSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotenv } from './load-dotenv';

// All agents share one justudhari_test DB. Concurrent runs deadlocked in truncateAll (Postgres 40P01)
// and clobbered each other's data, so a run takes a cross-process lock for its whole duration; others
// queue. A crashed run's lock is stolen after STALE_MS so the team never wedges.
const LOCK = join(tmpdir(), 'justudhari-test-db.lock');
const STALE_MS = 20 * 60_000;

async function acquireLock(): Promise<void> {
  for (;;) {
    try {
      closeSync(openSync(LOCK, 'wx')); // atomic create-if-absent
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
          rmSync(LOCK, { force: true }); // steal a crashed run's lock
          continue;
        }
      } catch {
        continue; // lock vanished between stat and now — retry the create
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// migrate deploy (not reset): non-destructive and not AI-blocked; per-test truncateAll handles data isolation.
export default async function setup(): Promise<() => void> {
  loadDotenv();
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('[test] TEST_DATABASE_URL (or DATABASE_URL) is not set — cannot run the integration suite.');
  }
  const release = () => {
    try {
      rmSync(LOCK, { force: true });
    } catch {
      /* already gone */
    }
  };
  await acquireLock();
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL } });
  } catch (e) {
    release(); // don't make the next run wait out the stale timeout after a migrate failure
    throw e;
  }
  return release;
}

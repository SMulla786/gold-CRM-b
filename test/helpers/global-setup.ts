import { execSync } from 'node:child_process';
import { loadDotenv } from './load-dotenv';

// Runs once before the whole suite: apply committed migrations to the test DB.
// migrate deploy (not reset) is non-destructive and NOT blocked for AI agents; per-test truncateAll()
// handles data isolation. Fails loudly so a broken test DB never masquerades as "red tests".
export default function setup(): void {
  loadDotenv();
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('[test] TEST_DATABASE_URL (or DATABASE_URL) is not set — cannot run the integration suite.');
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL },
  });
}

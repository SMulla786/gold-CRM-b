import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres (TEST_DATABASE_URL); run files serially so per-test
// truncation in one file can't wipe another file mid-run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/helpers/setup-env.ts', './test/helpers/setup-db.ts'],
    globalSetup: ['./test/helpers/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

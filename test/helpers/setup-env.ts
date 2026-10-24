import { loadDotenv } from './load-dotenv';

// Runs before every test file's imports, so src/config/env.ts parses against these.
loadDotenv();

process.env.NODE_ENV = 'test';
// Point the app at the test DB. The fallback keeps env parsing alive before DB READY — tests then fail on
// connect, which is the expected red state, rather than crashing at import.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://localhost:5432/justudhari_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

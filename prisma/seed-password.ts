import { createHash } from 'node:crypto';
import argon2 from 'argon2';

/** The value .env.example ships with — the seed refuses it, so nobody can seed with a known password by copying the example. */
export const SEED_PASSWORD_PLACEHOLDER = '<set-a-strong-unique-password>';

// sha256 of the old default Super Admin password, published in git history (backend .env.example, da5d004).
// Kept as a hash so the value never appears in code again.
const LEAKED_SHA256 = new Set(['e5bf4ea9d3ca8e7b01358689ef7fa132071ecb0adc8fddf8d4b268c868354707']);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Why the Super Admin seed password must be refused, or null when it is acceptable. The reason never contains the value. */
export function seedPasswordProblem(pw: string | undefined, leaked: ReadonlySet<string> = LEAKED_SHA256): string | null {
  if (!pw?.trim()) return 'is not set';
  if (pw === SEED_PASSWORD_PLACEHOLDER) return 'is still the .env.example placeholder';
  if (leaked.has(sha256(pw))) return 'is the old default that is public in git history';
  // stricter than the app's user policy (8–100): this is the platform's most powerful account
  if (pw.length < 12 || pw.length > 100) return 'must be 12–100 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'must mix at least 3 of: lowercase, uppercase, digits, symbols';
  return null;
}

/** Validates SEED_SUPERADMIN_PASSWORD and returns its argon2 hash; throws (without the value) before anything is written. */
export async function seedPasswordHash(pw = process.env.SEED_SUPERADMIN_PASSWORD, leaked?: ReadonlySet<string>): Promise<string> {
  const problem = seedPasswordProblem(pw, leaked);
  if (problem) throw new Error(`Refusing to seed: SEED_SUPERADMIN_PASSWORD ${problem}. Set a strong, unique value in backend/.env (never a shared or example one).`);
  return argon2.hash(pw!);
}

# backend/test — Test-case catalogue (TASK-8)

Owner: tester. Scope: integration tests (vitest + supertest) against a real test Postgres (native PG 18 on localhost:5432, **not** docker), reset per run. Playwright e2e lives in `frontend/e2e`. Workspaces: `@ju/api` (backend), `@ju/web` (frontend), `@ju/shared`.

Status legend: ☐ to write · ▢ infra blocked on READY TASK-1 · ✔ passing.
Convention: each case = **GIVEN** state → **WHEN** request → **THEN** expected. "scoped reject" = **404 `NOT_FOUND`** (never 403) when hiding another tenant's row by id, so existence isn't leaked.

**Error body shape (confirmed by lead):** `{ error: { code, message, details? } }`. Codes asserted below:
`INVALID_CREDENTIALS` (401, same message for wrong-pwd and unknown-user), `ACCOUNT_BLOCKED` (403), `NOT_FOUND` (404), `FORBIDDEN` (403, missing permission), `READ_ONLY` (403, no/expired subscription), `PLAN_LIMIT` (403), `MODULE_DISABLED` (403, module not in plan).

## Infra (write once READY TASK-1 lands)
- `test/helpers/db.ts` — connect to test DB from `DATABASE_URL`, truncate-all + reseed between suites (fast path; fall back to `prisma migrate reset` if schema drifts).
- `test/helpers/factory.ts` — build Business → Branch subtree → Users (SUPER_ADMIN / ADMIN / branch-admin / plain BRANCH_USER) with roles+permissions; login helper returning access token + refresh cookie.
- `test/helpers/app.ts` — boot Express app once, supertest agent per role.
- One command: `npm run test` (backend). Suite must fail **red before TASK-4**, **green after** (tenancy scoping extension).

---

## 1. Auth (verifies TASK-3) — `test/auth/*.test.ts`

| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| A1 | seeded active user | POST /auth/login correct email+password | 200, access token + httpOnly refresh cookie set; body omits password hash |
| A2 | seeded user | POST /auth/login wrong password | 401 `INVALID_CREDENTIALS`, no cookie, generic message |
| A3 | user flagged blocked/deleted | POST /auth/login correct password | 403 `ACCOUNT_BLOCKED` — login refused |
| A4 | unknown email | POST /auth/login | 401 `INVALID_CREDENTIALS`, **same message as A2** (no enumeration) |
| A5 | valid refresh cookie | POST /auth/refresh | 200, **new** access token **and rotated** refresh cookie; old refresh value no longer accepted (A6) |
| A6 | refresh token already rotated (reused) | POST /auth/refresh with old cookie | 401 — rotation invalidates prior token |
| A7 | logged-in session | POST /auth/logout then POST /auth/refresh with that cookie | logout 200/204; subsequent refresh 401 (revoked) |
| A8 | valid access token | GET /auth/me | 200; shape = `{ userId, level, businessId, scopeBranchId, branchIds[], permissions/roles }`; never returns hash |
| A9 | no / expired access token | GET /auth/me | 401 |
| A10 | user with MPIN set | POST /auth/mpin/verify correct MPIN | 200 ok:true |
| A11 | user with MPIN set | POST /auth/mpin/verify wrong MPIN | 401/200 ok:false (match impl); repeated wrong does not crash |
| A12 | user without MPIN | POST /auth/mpin/set then /verify | set 200; verify with new MPIN 200 |
| A13 | argon2 hashing | inspect stored user after set-password/seed | hash starts `$argon2`, not plaintext; login still succeeds |
| A14 | OTP reset (stub) | POST /auth/reset request | returns stub success shape without sending real OTP (documents stub boundary) |

## 2. Tenancy & roles isolation (verifies TASK-4) — `test/tenancy/*.test.ts`
Source: plan Verification §Tenancy a–e. These are the core product-risk tests (data leaks). Must go red before the Prisma scoping extension, green after.

### (a) Cross-tenant / cross-branch read+write
| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| T-a1 | branch user of Business A; a known row id in Business B | GET that row by id | scoped reject (404) |
| T-a2 | same | PATCH/DELETE that B row by id | scoped reject (404), B row unchanged |
| T-a3 | branch user of Business A, branch X; a row in sibling branch Y (same business) | GET by id | scoped reject (404) |
| T-a4 | same | POST create referencing branch Y | rejected — cannot write outside own branch scope |
| T-a5 | list endpoint as branch user | GET /<resource> | returns only own-branch rows; count excludes other businesses/branches |

### (b) Admin consolidation & branch-admin subtree
| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| T-b1 | ADMIN of Business A with branches X,Y,Z | GET consolidated ("All branches") totals | equals sum of per-branch totals |
| T-b2 | ADMIN | GET any single branch's data | allowed for every own branch |
| T-b3 | branch-admin at node P (subtree P→children) | GET data | sees only P subtree; **not** parent or siblings (scoped reject on those ids) |
| T-b4 | branch-admin at P | POST create sub-branch under P | allowed |
| T-b5 | plain BRANCH_USER | POST create sub-branch | 403 `FORBIDDEN` (no permission) |
| T-b6 | branch moved under a different parent | re-fetch as the new parent's admin | subtree access updated to include moved branch; old parent loses it |

### (c) Subscription read-only guard
| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| T-c1 | business with expired/no subscription | POST/PATCH/DELETE any tenant resource | 403 `READ_ONLY` |
| T-c2 | same | GET any resource | 200 (reads still work) |
| T-c3 | active subscription | write | allowed (control) |
| T-c4 | subscription active but module not in plan | any request to that module | 403 `MODULE_DISABLED` |

### (d) Plan-limit guards
| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| T-d1 | business at branch-count plan limit | POST create branch | 403 `PLAN_LIMIT`, no branch created |
| T-d2 | business at user-count plan limit | POST create user | 403 `PLAN_LIMIT`, no user created |
| T-d3 | under limit | create | allowed (control) |

### (e) Super-admin impersonation auditing
| # | GIVEN | WHEN | THEN |
|---|---|---|---|
| T-e1 | SUPER_ADMIN | impersonate a business/user via platform route | action succeeds **and** an audit log row is written (actor=super-admin, target, timestamp) |
| T-e2 | SUPER_ADMIN without impersonation | hit a tenant route directly | blocked (platform routes never touch tenant data un-audited) |

## 3. Deferred (later tasks, catalogued now)
- Bill save side-effects (plan Verification §API): sell-bill save creates bill+items+payments+ledger, marks stock sold, updates party balance; delete-with-return reverses all. → when billing module lands.
- Permission & MPIN guards reject per RBAC matrix (`docs/modules/12-rbac.md`) incl. view-days limit. → with TASK-5.
- Invoice numbering gap-free under concurrent saves (concurrency test). → with billing.

---
Error contract confirmed by lead (2026-10-24). No open questions outstanding.

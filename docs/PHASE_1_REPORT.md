# Phase 1 report — foundation and first vertical slice

Branch: `phase-1/foundation-vertical-slice` (from `phase-0/plan`).
Scope: `IMPLEMENTATION_PLAN.md` §7. This report states what exists, how it was verified, and what is not done. It makes no production-readiness or capacity claim; no load testing has been performed.

## 1. What was built

| Area | Location | Notes |
|---|---|---|
| Database + migrations | `packages/db` | PostgreSQL 16, forward-only SQL migrations 0001–0009, forced RLS on every tenant table, least-privilege roles |
| Contracts | `contracts/`, `packages/contracts` | Org map v2, adapter result v1, event envelope v1 schemas; Ajv validators with referential checks; generated `openapi.v1.json` |
| API / control plane | `apps/api` | Fastify modular monolith, OIDC sessions, RBAC, tenant-scoped modules, outbox + relay, Temporal workflow and control activities |
| Research worker | `workers/research` | Python Temporal worker; deterministic mock adapters behind a typed adapter protocol; budget and timeout ceilings |
| Web UI | `apps/web` | Next.js App Router; typed client generated from OpenAPI; accessible pages for the §7.1 journey |
| Local infrastructure | `infra/compose` | Postgres, Redis, Temporal dev server, RustFS (S3), Keycloak with a synthetic dev realm, research worker |
| CI | `.github/workflows/ci.yml` | Static checks, unit, contract drift, integration, Python, secret scan, dependency audit, image build + Trivy, Playwright E2E |
| Images | `apps/api/Dockerfile`, `apps/web/Dockerfile`, `workers/research/Dockerfile` | Non-root, OS packages upgraded at build, package managers removed from Node runtimes |

## 2. Verification (commands actually run, results observed)

Run on Windows 11, Node 24.11.0, Python 3.12.10, Docker Desktop.

| Command | Result |
|---|---|
| `pnpm format:check` | All files formatted |
| `pnpm lint` | No problems |
| `pnpm typecheck` | db, contracts, api, web clean |
| `pnpm test` (unit) | contracts 13/13, api 33/33 |
| `pnpm test:integration` | db 10/10 (RLS), api 32/32 — 29 vertical-slice/isolation tests plus 3 tests of the real workflow on a Temporal dev-server container |
| `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` (workers/research) | clean; mypy strict clean; 12/12 |
| `pnpm --filter @mapforce/web build` | succeeds |
| `pnpm --filter @mapforce/web test:e2e` against the live local stack | 2/2: full journey via real Keycloak sign-in, Temporal and the containerised Python worker, axe WCAG 2 A/AA (no serious/critical) on login, workspaces, ICP, company, person and audit pages; Bob gets "not found" for Alice's company |
| gitleaks v8.30.1 over full history | no leaks |
| `pnpm audit --prod --audit-level high` | no known vulnerabilities |
| pip-audit 2.10.0 (worker, prod deps) | no known vulnerabilities |
| `docker build` api, web, research-worker + Trivy 0.69 (HIGH/CRITICAL, fixable) | 0 findings for all three after remediation (see §6) |
| Image smoke: API `/readyz`, control worker reaches `RUNNING`, web serves `/login` with production CSP | passed |

GitHub Actions [run 38113913381](https://github.com/drmtraza/mapforce_revamped/actions/runs/38113913381) on this branch: all 8 jobs succeeded (static checks + unit + contract drift, integration, Python worker, secret scan + dependency audit, three image builds with Trivy, and the full-stack Playwright E2E on a clean Ubuntu runner).

## 3. Acceptance criteria (IMPLEMENTATION_PLAN §11, Phase 1)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | OIDC sign-in; httpOnly/SameSite cookie, secure in prod; no tokens in browser storage | Met | E2E sign-in through Keycloak; config refuses `COOKIE_SECURE=false` in production; session token is opaque, stored hashed |
| 2 | Creator becomes owner; RBAC enforced server-side | Met | integration: workspace creation, auditor write denial audited |
| 3 | ICP update creates a new version | Met | integration + E2E |
| 4 | Same domain / Idempotency-Key → one company, one job | Met | integration (concurrent submits) |
| 5 | 202, documented statuses, `partial_success` with per-source outcomes | Met | integration (fixture and real Temporal); the mock registry fails deterministically for domains containing `outage` |
| 6 | Every claim has evidence with URL, provider, fetched_at, hash; inferred edges carry confidence + rationale + evidence | Met | persistence validation + integration |
| 7 | Invalid adapter payload quarantined; nothing written to canonical tables | Met | integration |
| 8 | Review persists and is audited | Met | integration + E2E |
| 9 | Org map distinguishes verified vs inferred in API and UI | Met | contract validation + E2E (solid vs dashed, labelled) |
| 10 | Audit trail lists §7.1 actions with actor, correlation ID, outcome | Met | E2E checks workspace, ICP, company, research requested/completed, review |
| 11 | Isolation across API, DB RLS, background job, object storage | Met | db RLS suite; API 404 suite; activity rejects cross-tenant writes; tenant-prefixed keys + URL issuance after authorization |
| 12 | Bounded retries and timeouts everywhere | Met | control activities 5 attempts/1 min; adapters 3 attempts, 1 min start-to-close, 5 min schedule-to-close; worker 45 s timeout and record ceilings; outbox dead-letters after 10 attempts; workflow 30 min execution timeout |
| 13 | CI green | Met | GitHub Actions run 38113913381, 8/8 jobs |
| 14 | `docker compose up` + one command reproduces the demo with zero credentials | Partially met | infra and worker run in compose with placeholder credentials; API, control worker and web run as three host commands (see README). Containerising them needs an OIDC issuer reachable identically from browser and containers — planned for Phase 2 |

## 4. Migrations

`0001_foundation`, `0002_identity_tenancy`, `0003_audit`, `0004_outbox`, `0005_icp`, `0006_sources_companies`, `0007_jobs_usage`, `0008_evidence_claims`, `0009_people_relationships`. All forward-only; run with `pnpm db:migrate` as the schema owner. The runner takes an advisory lock and refuses to continue if an applied file's checksum changed.

## 5. Configuration and operational changes

- Environment variables: see `.env.example` (placeholders only) and `apps/api/src/config.ts` (validated at start-up; production requires `COOKIE_SECURE=true` and `OIDC_ALLOW_INSECURE_HTTP=false`). Web: `API_ORIGIN` (build time). Worker: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `RESEARCH_TASK_QUEUE`, `FEATURE_MOCK_PROVIDERS`, `LOG_LEVEL`.
- Database roles: `mapforce_owner` (migrations), `mapforce_app` (API/worker, RLS enforced), `mapforce_relay` (outbox only).
- Compose host ports are overridable (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `S3_HOST_PORT`, …) for machines with conflicting services.
- Processes: API (`apps/api/src/server.ts`), control worker + outbox relay (`apps/api/src/temporal/worker-main.ts`), Python research worker, web.

## 6. Deviations from the approved plan

| Plan | As built | Reason |
|---|---|---|
| MinIO for local S3 | RustFS 1.0.1 | MinIO no longer publishes the images the plan assumed; RustFS is S3-compatible and the code uses the AWS SDK only |
| `node-pg-migrate` | Small SQL runner (`packages/db/src/migrate.ts`) | Plain SQL files, advisory lock and checksums with no extra dependency |
| `idempotency_keys` table | Removed | Job idempotency comes from the `(tenant, idempotency_key)` unique key plus a partial unique index allowing one active job per company |
| Separate RLS migration (0011) | RLS defined in each table's migration | A table never exists without its policy |
| Migration numbering in §8 | 0001–0009 as listed above | Tables grouped by module |
| Build step for TypeScript | Node native type stripping | Fewer moving parts; `erasableSyntaxOnly` enforced |
| Outbox payload | Carries `workflow_input` | The relay role cannot read tenant tables by design |
| Python adapters cancel promptly | Adapters do not heartbeat; a cancelled job finalises immediately and a running adapter finishes within its 1-minute bound, its result discarded | Acceptable for mock adapters; heartbeating is planned with real providers |

The added endpoint `GET /evidence/{id}/content-url` was approved with D8.

## 7. Known risks and gaps

- Rate limiting keys on IP for most requests because the limiter runs before authentication; per-tenant limits arrive with quotas in Phase 5.
- Keycloak runs in dev mode with synthetic users; production identity configuration is out of scope.
- The web app uses client-side data fetching with polling (2 s, bounded) for job status.
- `next start` warns under `output: 'standalone'`; production images run `server.js` as Next recommends.
- No load, soak or failover testing yet; no capacity or availability claim is made.
- Action versions in CI are pinned to release tags, not commit SHAs.

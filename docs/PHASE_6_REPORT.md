# Phase 6 report — Hardening and scale

Branch: `phase-6/hardening-scale`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-5/bd-workspace` (`950d4aa`)

This report does **not** claim production readiness, 10K concurrent users, or 1M registered users.

## What landed

- **Process metrics.** `GET /metrics` emits Prometheus text (request counts, duration buckets, 429s, DB pool gauges). No tenant labels. Restrict at ingress outside local use.
- **Readiness.** `GET /readyz` checks Postgres and Redis (when configured) and returns 503 if either fails. `GET /healthz` remains liveness-only.
- **Ops API.** `GET /ops/status`. `GET/PATCH /workspace-controls` kill switches. `GET /ops/retention` and `POST /ops/retention-sweep` (redact up to 100 expired evidence excerpts; suppression hashes kept).
- **Queue fairness.** `TENANT_CONCURRENT_JOB_LIMIT` (default 8) counts queued + running + cancel_requested jobs per workspace.
- **Rate limits.** Hook is `preHandler`; key is `user:{id}:ws:{workspace}` or IP. Export 10/min and job starts 30/min.
- **DB pool.** `connectionTimeoutMillis` 5s; `poolStats()` for `/metrics` and `/ops/status`.
- **Indexes** in `0014_hardening.sql` for export quota, active jobs, AI tokens, pipeline stage, evidence retention.
- **Grafana** starter: `infra/observability/grafana-mapforce.json`.
- **k6** operator script: `infra/load/health.js`. Not run in CI.
- **Runbooks** under `docs/runbooks/` (backup/restore, incident, alerts, privacy, security review).
- **UI:** Settings → Operations.
- **D13 hosting** is still unset.

## Migrations and env

| Change | Notes |
|---|---|
| `packages/db/migrations/0014_hardening.sql` | Indexes + `workspace_controls` with FORCE RLS |
| `TENANT_CONCURRENT_JOB_LIMIT` | Default 8 |
| `RATE_LIMIT_EXPORT_PER_MINUTE` | Default 10 |
| `RATE_LIMIT_JOB_PER_MINUTE` | Default 30 |
| `FEATURE_RESEARCH` / `DISCOVERY` / `ENRICH` / `AI` / `EXPORT` | Default true; global false wins |

Forward-only. Restore from backup + replay if 0014 must be undone.

## Workload that was actually exercised

| Workload | Result |
|---|---|
| In-process authenticated `GET /companies` × 40 | Asserted in `hardening.test.ts` (p95 < 2000 ms) |
| k6 `health.js` | Not run (operator script only) |
| 500 / 1_000 / 10_000 sessions | Not run (D13 open) |
| Soak / live providers | Not run |

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format` / lint / typecheck | passed |
| contracts vitest | 29 passed |
| API unit | 64 passed |
| API integration | 73 passed (includes kill switch, concurrent cap, retention sweep, ops 404 isolation, in-process p95 bound) |
| db RLS + backup restore | 15 passed (`pg_dump` into a second Postgres 16 container) |
| Python ruff / mypy / pytest | ruff passed; mypy clean; 82 passed |
| Playwright `hardening.spec.ts` | not run (needs live API/web) |
| k6 `infra/load/health.js` | not run |
| gitleaks / pnpm audit / Trivy | not re-run locally; still in CI |

## Exit criteria (honest)

Runbooks and a starter dashboard exist. Backup restore was verified in Testcontainers, not on a managed host. In-process read p95 is bounded in the suite; that is not a 10K-session proof. D13 hosting is unset.

Phase 7 starts only after owner review of this report.

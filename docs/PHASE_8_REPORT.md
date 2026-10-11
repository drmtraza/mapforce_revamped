# Phase 8 report — Review, refactor and deployability

Branch: `phase-8/review-refactor`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-7/controlled-rollout` (`628f8ff`)

This report does **not** claim production readiness, cloud provisioning, or scale capacity. D12 stays off. D13 has a proposed ADR only.

## Why this phase

Kit roadmap Phases 0–7 were complete. Prompt 8 (review/refactor) plus a D13 deployability blueprint were the highest-value next step without inventing licensed-provider credentials or a cloud account.

## What landed

- **Metrics gating.** `METRICS_TOKEN` (`x-metrics-token`); production without a token returns 404.
- **OpenAPI gating.** `EXPOSE_OPENAPI` (default false; tests/local example set true).
- **Bounded reads.** SQL sums for provider cost and AI tokens; list item counts via `groupBy`; person-detail and AI-gather side loads capped.
- **Contact crypto.** `configureContactFieldKey` from validated `Config` at `buildApp`.
- **Isolation.** API IDOR matrix (`isolation-matrix.test.ts`); RLS coverage for budgets/feedback/incidents/lists.
- **A11y.** Pipeline stage selects uniquely labelled.
- **Deployability docs.** `docs/adr/D13_HOSTING_RECOMMENDATION.md`, `docs/runbooks/STAGING_DEPLOY.md`, `infra/compose/staging.env.example`.
- **Env/docs.** `.env.example` documents `API_ORIGIN`, `E2E_BASE_URL`, worker queue/concurrency, scrape tokens; contract changelog updated through Phase 8.

## Remaining limitations (honest)

| Item | Status |
|---|---|
| D12 licensed contacts | Still disabled |
| D13 vendor choice | Proposed ADR; owner must pick AWS/GCP/Azure |
| Cloud CD / hosted synthetic probe | Not run |
| 10K concurrent / 1M users | Not proven |
| Playwright a11y on Pipeline | Not run in this phase |
| Billing integration | Still deferred |

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format` / lint / typecheck | passed |
| OpenAPI regen + `gen:api` | passed |
| contracts vitest | 29 passed |
| API unit | 68 passed |
| API integration | 81 passed (includes isolation matrix + OpenAPI hide) |
| db RLS + backup restore | 16 passed |
| Python ruff / mypy / pytest | ruff passed; mypy clean; 82 passed |
| Playwright / hosted staging | not run |
| gitleaks / pnpm audit / Trivy | not re-run locally; still in CI |

## Exit criteria

Highest-risk review findings from Prompt 8 were fixed or documented. Staging/D13 blueprint exists without overclaiming that a host is live. Next owner decisions: approve D13 vendor, then D12 procurement if contacts are required.

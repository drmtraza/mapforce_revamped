# Phase 7 report — Controlled rollout

Branch: `phase-7/controlled-rollout`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-6/hardening-scale` (`1664e15`)

This report does **not** claim production readiness, GA capacity, or scale. `ga` is a packaging tier with higher plan ceilings only.

## What landed

- **Plans.** `development` | `beta` | `ga` with `PLAN_CAPS`. Effective limits = clamp(override/env, plan ceiling). New workspaces default to `DEFAULT_TENANT_PLAN` (beta in `.env.example`; tests force `development`).
- **Beta seats.** `MAX_BETA_TENANTS` enforced via `count_tenants_on_plan('beta')` (SECURITY DEFINER) on workspace create and plan patch to beta.
- **Feature flags.** Global `feature_flags` + per-tenant overrides. Seeded: `live_search`, `licensed_contacts`, `hermes`, `bulk_export`, `beta_feedback`.
- **Provider cost ceiling.** `daily_provider_cost_ceiling` on budgets; checked at job start with concurrent caps.
- **Feedback.** `POST/GET /feedback` for beta-style product notes.
- **Data quality review.** `GET /ops/data-quality` (people review buckets, AI quarantine, suppressions, open feedback/incidents).
- **Synthetic monitoring.** Token-gated `GET /synthetic/probe`; workspace `POST /ops/synthetic-check`; operator script `infra/synthetic/probe.mjs`.
- **Quota ramp.** `POST /workspace-budget/ramp` records rationale and refuses values above plan ceiling.
- **Incident triage.** `GET/POST /ops/incidents`, `PATCH /ops/incidents/{id}`.
- **UI.** Settings → Controlled rollout (plan, flags, feedback, quality snapshot) + usage shows plan/provider meters.
- **Runbook.** `docs/runbooks/CONTROLLED_ROLLOUT.md`.

## Migrations and env

| Change | Notes |
|---|---|
| `packages/db/migrations/0015_controlled_rollout.sql` | plan check, budgets column, flags, feedback, synthetic, ramp, incidents, `count_tenants_on_plan` |
| `DEFAULT_TENANT_PLAN` | Default `beta` |
| `MAX_BETA_TENANTS` | Default 25 |
| `TENANT_DAILY_PROVIDER_COST_CEILING` | Default 25 |
| `SYNTHETIC_PROBE_TOKEN` | Empty disables probe (404) |

Forward-only. Restore from backup + replay if 0015 must be undone.

## Workload that was actually exercised

| Workload | Result |
|---|---|
| Beta seat cap (2 seats → third create 429) | Asserted in `rollout.test.ts` |
| Feature flag override + feedback + quality + synthetic check + ramp | Asserted in integration |
| Provider cost / plan clamp unit tests | Asserted in `rollout.test.ts` |
| Live beta cohort / gradual production ramp | Not run |
| Synthetic probe against a hosted stack | Not run (script only) |

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format` / lint / typecheck | passed |
| OpenAPI regen + `gen:api` | passed |
| contracts vitest | 29 passed |
| API unit | 67 passed |
| API integration | 78 passed (includes rollout suite) |
| db RLS + backup restore | 15 passed |
| Python ruff / mypy / pytest | ruff passed; mypy clean; 82 passed |
| Playwright | not run (needs live API/web) |
| Hosted synthetic probe / operator beta cohort | not run |
| gitleaks / pnpm audit / Trivy | not re-run locally; still in CI |

## Exit criteria (honest)

Controlled-rollout controls exist: plan ceilings, beta seat bound, flags, feedback, synthetic probe endpoint, quota ramp audit, and a data-quality snapshot. That is packaging and ops hygiene for a limited trial — not evidence that the product is ready for general availability or high concurrency. D12 (licensed contacts) and D13 (hosting) remain open.

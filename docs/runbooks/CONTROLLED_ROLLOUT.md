# Runbook — controlled rollout (Phase 7)

## Goals

Admit a **limited** set of beta workspaces, watch synthetic probes and data-quality counters, and raise quotas only within plan ceilings. This is not a public GA launch and does not claim 10K capacity.

## Plans

| Plan | Intent |
|---|---|
| `development` | Local and CI (default in tests) |
| `beta` | Limited external/beta tenants (`MAX_BETA_TENANTS`) |
| `ga` | Packaging tier with higher ceilings — not a readiness certificate |

Ceilings live in `apps/api/src/modules/rollout/plans.ts`. Effective limits are `min(override or env default, plan ceiling)`.

## Feature flags

Global rows in `feature_flags` (live_search, licensed_contacts, hermes, bulk_export, beta_feedback). Workspace owners/admins may set tenant overrides; global `false` is the safe default for paid/live providers until D12/D14 and Hermes evaluation finish.

## Synthetic monitoring

1. Set `SYNTHETIC_PROBE_TOKEN` (≥16 chars) on the API.
2. Schedule `node infra/synthetic/probe.mjs` every 1–5 minutes from a private runner.
3. Workspace operators can also `POST /api/v1/ops/synthetic-check`.

## Feedback and triage

- Users: `POST /feedback` (no contact values).
- Operators: `GET /ops/data-quality`, `POST /ops/incidents`, severity P0–P3 per `INCIDENT_RESPONSE.md`.

## Quota ramp

Use `POST /workspace-budget/ramp` with a rationale. Values above the plan ceiling return `QUOTA_EXCEEDED`. Prefer small steps after reviewing usage and synthetic checks.

## Do not

- Copy real prospect data into tickets.
- Enable Hermes or licensed contacts without provider approval.
- Raise `MAX_BETA_TENANTS` or GA ceilings without reviewing Phase 6 constraints and hosting (D13).

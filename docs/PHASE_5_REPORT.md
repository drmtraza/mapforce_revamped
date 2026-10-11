# Phase 5 report — BD workspace

Branch: `phase-5/bd-workspace`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-4/ai-orgmap` (`5f1db5b`)

## What landed

- **Explainable scoring** (`icp-explainable/1.0.0`) is deterministic. Versioned `scoring_policies` hold integer weights that must sum to 100: `icp_fit` 30, `role_relevance` 20, `intent` 20, `completeness` 15, `corroboration` 15. Each factor stores a value, max and rationale. The total is labelled a heuristic, not a probability. Hiring is not treated as approved budget.
- **Suppression and ICP `excluded_domains` override** scoring to `total 0` / `eligible: false`. Suppressed companies cannot be added to lists and are omitted from export. Suppression still wins over score, list membership and outreach.
- **Pipeline** via `account_assignments`: stages `identified|researching|qualified|outreach|meeting|closed_won|closed_lost|on_hold`; owner must be an active workspace member.
- **Lists, tasks and notes** are tenant-scoped. List items reject the wrong entity kind and suppressed subjects (`409 SUPPRESSED`).
- **Controlled export** (`POST /exports`) returns a formula-injection-safe CSV inside JSON (`csv`, `filename`, `row_count`, `omitted_suppressed`). Cells matching `^[=+\-@\t\r]` are prefixed with `'` and quoted. Contact values are never exported. Daily export quota defaults to `TENANT_DAILY_EXPORT_LIMIT` (20).
- **Usage and admin budgets.** `GET /usage` reports 24h jobs / exports / AI tokens / provider rows plus effective limits. `GET/PATCH /workspace-budget` stores optional `tenant_budgets` overrides; missing values fall back to config. Research, enrich, AI and export quotas now resolve through `resolveTenantLimits`.
- **Outreach drafts** can be `approved` or `rejected` (`PATCH /outreach-drafts/:id`). The product still does not send them.
- **UI:** Pipeline board, Lists, company BD panel (score / add to list / tasks / notes), ICP scoring-weight form, Settings usage and budget. Billing copy states that plan integration is not enabled.
- **Billing/plan integration is not implemented.** Pricing and packaging remain unapproved.

## Migrations and env

| Change | Notes |
|---|---|
| `packages/db/migrations/0013_bd_workspace.sql` | `scoring_policies` (one active per tenant), `score_runs`, `account_assignments`, `workspace_lists`, `list_items`, `tasks`, `notes`, `export_batches`, `tenant_budgets`. `GRANT` to `app_rw`. `FORCE ROW LEVEL SECURITY` on all. |
| `TENANT_DAILY_EXPORT_LIMIT` | Default 20 export batches / workspace / 24 h. Overridable per tenant. |

Forward-only. Restore from backup + replay if 0013 must be undone. Planned kit numbers 0016–0018 were collapsed into this single migration.

## API (additive)

- `GET/POST /scoring-policies`
- `POST /icp-profiles/:id/score-runs` (max 200 companies)
- `GET /score-runs/:id`
- `GET /companies/:id/score` — `404` if the company is not in the tenant; `{ score: null }` when the company exists but has no run
- `GET /accounts`, `PATCH /accounts/:companyId`
- `GET/POST /lists`, `GET /lists/:id`, `POST /lists/:id/items`, `DELETE /lists/:id/items/:itemId`
- `GET /companies/:id/tasks`, `POST /tasks`, `PATCH /tasks/:id`
- `GET /companies/:id/notes`, `POST /notes`
- `PATCH /outreach-drafts/:id` (`approved` \| `rejected`)
- `POST /exports` (`scope: companies|list`)
- `GET /usage`, `GET/PATCH /workspace-budget`

Permissions: `score.run`, `list.read/write`, `account.assign`, `task.write`, `note.write`, `export.start`, `usage.read`, `budget.manage`.

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format:check` | passed |
| `pnpm lint` | passed (fixed unused `display` assignment in `lists/routes.ts`) |
| `pnpm typecheck` | passed |
| contracts vitest | 29 passed |
| API unit | 59 passed (includes weight sum, suppression/exclusion override, CSV formula prefix) |
| API integration | 67 passed (score, assign/task/note, suppression on list + omitted from export + formula-safe cell, usage, cross-tenant 404 on score/list/export-list) |
| db RLS | 14 passed (includes “every `tenant_id` table has FORCE RLS”) |
| Python ruff / mypy / pytest | ruff passed; mypy clean; 82 passed (Windows printed a WMI `0x8007000e` during import; tests still completed) |
| Playwright e2e (`bd-workspace.spec.ts`) | not run in this turn (needs live API/web + researched company) |

## Exit criteria

Suppression is enforced on scoring, list add and export. Usage for the last 24 hours is readable. Tenant budget overrides are auditable. Exports are audited and omit contact values. Drafts remain human-review only.

## Risks / still open

- Billing, plans and Stripe are deferred until pricing/packaging are approved. Admin budgets are workspace overrides only.
- Export is a JSON-wrapped CSV (OpenAPI-friendly), capped at 500 rows, not a streamed `text/csv` download.
- Score-run overlay personas are aligned to people by index from the latest AI run; a missing or reordered overlay falls back to title taxonomy.
- Playwright BD-workspace journey was written and not executed here.
- D12 licensed contact provider still open (adapter stays disabled).
- One-command compose for API/web remains a later item.
- This report does **not** claim production readiness or scale capacity.

Phase 6 (hardening and scale) starts only after owner review of this report.

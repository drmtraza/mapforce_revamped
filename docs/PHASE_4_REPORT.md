# Phase 4 report — AI organization mapping

Branch: `phase-4/ai-orgmap`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped

## What landed

- **D9:** model-provider abstraction in the TypeScript control plane. Deterministic **mock** is the default. **Hermes HTTP** is compiled in but globally disabled until `FEATURE_HERMES=true` and `HERMES_BASE_URL` are set. Crawl workers never receive database credentials or model keys.
- **Skill** `skills/b2b_org_deducer/SKILL.md` is wired as prompt version `b2b_org_deducer/1.0.0`. The model receives compact people, sourced relationships, signals and **fenced untrusted excerpts**. Excerpts are never treated as instructions.
- Output is validated against `org-map.v2` and **grounded** against supplied `person_id` / `evidence_id` values. Fabricated people, unknown IDs, emails in outreach, and `model_inference` marked `verified` are rejected.
- Rejected or failed model output is written to **`ai_quarantine`**. A **deterministic fallback** (title taxonomy + already-sourced relationships) is persisted instead so the user still sees a usable map.
- **Personas** from titles: C-level → economic buyer; VP/head of engineering → technical evaluator; VP/head (other) → functional champion; manager/ops → operational user; procurement/legal/security → procurement. Seniority is not upgraded beyond the title.
- **GET `/companies/:id/org-map`** is unchanged until a successful or quarantined-with-fallback run exists (Phase 1 still sees `persona: unknown`). After a run, personas, outreach angles, unknowns and extra inferred edges overlay the sourced graph.
- **POST `/companies/:id/org-map-jobs`** runs gather + model + persist **in-request** (job row, not Temporal), bounded by `TENANT_DAILY_AI_RUN_LIMIT`, `AI_MAX_TOKENS` and `AI_TIMEOUT_MS`. Permission `orgmap.run` matches `people.review`.
- **Outreach drafts** are stored as `model_inference` for human review. The product does not send them. Suppressed people do not receive drafts. Hiring copy states that hiring is not approved budget.
- UI: **Run AI mapping**, persona labels on nodes, drafts list with the human-review note.

## Migrations and env

| Change | Notes |
|---|---|
| `packages/db/migrations/0012_ai_orgmap.sql` | `workflow_jobs.job_type` adds `company_orgmap`; `ai_runs`, `ai_quarantine`, `outreach_drafts` with forced RLS |
| `TENANT_DAILY_AI_RUN_LIMIT` | Default 20 org-map jobs / workspace / 24 h |
| `AI_MAX_TOKENS` | Default 4000 (prompt estimate) |
| `AI_TIMEOUT_MS` | Default 15000 |
| `FEATURE_HERMES` / `HERMES_BASE_URL` / `HERMES_API_KEY` | Leave off until a Hermes endpoint exists |

Forward-only. Restore from backup + replay if 0012 must be undone.

## API (additive)

- `POST /companies/:id/org-map-jobs`, `GET /org-map-jobs/:id`
- `GET /companies/:id/outreach-drafts`
- `GET /companies/:id/org-map` overlays the latest accepted/fallback run when present
- Events: `orgmap.inference.completed` (no Temporal subscriber; outbox acknowledges)

## Eval (mock only — honest)

| Metric | Result on labelled fixture |
|---|---|
| Citation validity | 100% (only supplied evidence IDs) |
| Fabricated people | 0 |
| Prompt-injection resistance | 100% (hostile excerpt ignored; hostile model quarantined) |
| Title → persona on Avery / Jordan / Riley | technical_evaluator / operational_user / procurement |

These thresholds are **not** claimed for Hermes. Hermes has not been evaluated against a live model.

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format:check` | passed |
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| contracts vitest | 29 passed |
| API unit | 53 passed |
| API integration | 63 passed |
| db RLS | 14 passed |
| Python ruff / mypy / pytest | 82 passed |
| Playwright e2e (`orgmap-ai.spec.ts`) | not run in this turn (needs live API/web + researched company) |

## Exit criteria

AI output is schema-validated and evidence-grounded before persist. Unsupported claims are quarantined and replaced by the fallback. Drafts are labelled model inference and are not sent.

## Risks / still open

- Hermes remains unevaluated; enabling it without a labelled comparison would be a quality risk.
- In-request mapping is adequate for the mock and a short Hermes timeout; a Temporal org-map workflow is still the right shape if hosted models become slow or expensive.
- One-command compose for API/web remains a later item.
- D12 licensed contact provider still open (adapter stays disabled).
- This report does **not** claim production readiness or scale capacity.

Phase 5 (BD workspace / scoring / export) starts only after owner review of this report.

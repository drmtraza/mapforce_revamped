# Phase 3 report — People, enrichment and signals

Branch: `phase-3/people-enrichment-signals`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped

## What landed

- Canonical people already existed; this phase adds **role history** (a new title marks the previous current role `past` instead of overwriting it), **match candidates** for the same normalized name at another company, and **human merge/split** that keeps the absorbed row and is reversible.
- **Contact status model** on `contact_points`: `unverified`, `provider_verified`, `deliverable_likely`, `invalid`, `catch_all`, `unknown`, `suppressed`. Guessed methods (`pattern`, `mx`, `none`) cannot be `provider_verified`. Values are AES-256-GCM encrypted; APIs return only a display hint.
- **`mock_contacts`** pattern-guesses `first.last@domain` and always labels it `unverified` / `pattern`.
- **`licensed_contacts`** is registered, **globally disabled**, and not loaded on the worker unless `FEATURE_LICENSED_CONTACTS=true` and `LICENSED_CONTACTS_API_KEY` are set. Even then the stub refuses to run until D12 is approved.
- **Signals:** `mock_careers` (hiring; `implies_budget` always false) and `mock_procurement` (synthetic US/UK/EU public notices). Company research now plans `fetch_intent_signals` alongside existing operations.
- **Budget-aware enrich waterfall:** `POST /people/:id/enrich-jobs` plans enrich sources, respects `TENANT_DAILY_ENRICH_LIMIT`, and the Temporal workflow skips `licensed_contacts` once a cheaper source has already persisted a contact.
- **Suppression** hashes only; matching contacts are marked `suppressed` and enrichment is skipped.

## Migrations and env

| Change | Notes |
|---|---|
| `packages/db/migrations/0011_people_contacts_signals.sql` | `people.merged_into_id`, aliases, match/merge, contact_points, consent_suppressions, intent_signals, `workflow_jobs.person_id` + `person_enrichment`, source rows |
| `CONTACT_FIELD_KEY` | Required, ≥32 chars. Local placeholder in `.env.example`. |
| `TENANT_DAILY_ENRICH_LIMIT` | Default 50 enrich jobs / workspace / 24 h. |
| `FEATURE_LICENSED_CONTACTS` / `LICENSED_CONTACTS_API_KEY` | Leave off until D12. |

Forward-only. Restore from backup + replay if 0011 must be undone.

## API (additive)

- `GET /people/:id` now includes contacts (hints only), aliases, proposed matches, active merges, role dates.
- `GET /people/match-candidates`, `POST .../accept`, `POST .../reject`, `POST /people/merges/:id/split`
- `POST /people/:id/enrich-jobs`, `GET /enrich-jobs/:id`
- `GET /companies/:id/signals`
- `GET/POST /suppressions`

## Checks that ran

| Check | Result |
|---|---|
| `pnpm format:check` | passed |
| `pnpm lint` | passed |
| `pnpm typecheck` (api after EventType fix) | passed |
| contracts vitest | 27 passed |
| API unit | 47 passed |
| API integration | 58 passed |
| db RLS | 13 passed |
| Python ruff / mypy / pytest | 82 passed |
| Playwright e2e (`enrichment-signals.spec.ts`) | not run in this turn (needs rebuilt worker + live API/web) |

## Exit criteria

No field is labelled verified without a documented method and source. Pattern guesses stay `unverified`. The licensed adapter does not run.

## Risks / still open

- D12 licensed provider + verification vendor still open; adapter stays disabled.
- SMTP recipient probing is not implemented (and must not become the default).
- One-command compose for API/web remains a later item (same as Phase 1/2).
- E2E enrich path needs the rebuilt Python worker and a running control worker + outbox relay.

Phase 4 (AI / org-map) starts only after owner review of this report.

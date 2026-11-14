# Phase 12 report — Product catalogue + opportunity matching

Branch: `phase-12/catalogue-matching`  
Date: 2026-11-15  
Base: `phase-11/baseline-audit` (Phase 11 **APPROVED**)

This report does **not** claim production readiness, Contabo deploy, D12 licensed contacts, Hermes enablement, or Stripe. Match scores are **not** ICP account scores.

## Why this phase

Phase 11 approved an additive Agentic BD OS path. Phase 12 ships the first commercial slice: tenant-scoped product/services catalogue and company→offering match heuristics with explicit non-intent labelling.

## What landed

- **Migration `0016_product_catalogue.sql`** — `product_offerings`, `product_documents`, `opportunity_match_runs`, `opportunity_match_results` (+ RLS); flags `product_catalogue`, `opportunity_matching`.
- **Match engine `product-match/1.0.0`** — industry/geo/size/persona/signals/evidence factors; suppression zeros score; commercial_potential separate; note states not buying intent / not ICP score.
- **API** — catalogue CRUD + documents; `POST/GET /companies/:id/opportunity-matches`; RBAC `catalogue.read|write`, `match.run`; audit on create/update/doc/match.
- **Web** — Product catalogue nav/page; company MatchPanel beside BD panel.
- **OpenAPI** regenerated; web types via `gen:api`.

## Checks that ran

| Check | Result |
|---|---|
| Unit `catalogue-match` + `pure` | pass |
| Integration `catalogue` (CRUD, match version, cross-tenant 404) | pass |
| `pnpm lint` / `typecheck` | pass |
| `pnpm format` (full tree) | blocked by local `.pytest_cache` EPERM; changed files formatted via Prettier |
| Contabo / packaging-smoke / e2e | not run (out of Phase 12 scope) |

## Preservation (unchanged)

- ICP `icp-explainable/1.0.0` scoring untouched.
- No auto-send; suppression still overrides match eligibility.
- Mock providers / Hermes / D12 remain off.
- Temporal-first agent work deferred to later phases.

## Remaining limitations

- Match is heuristic catalogue fit only — not win probability or calibrated revenue.
- No Temporal workflow for matching (sync API is enough for catalogue size ≤100).
- Document URIs are workspace-approved references, not scraped blobs.
- Contabo deploy remains owner/ops work outside this branch.

## Exit criteria

Catalogue + matching vertical slice is on `phase-12/catalogue-matching` with tests and contracts. Recommended next: **Phase 13 — Opportunity radar** (after owner go-ahead), still additive and flag-gated.

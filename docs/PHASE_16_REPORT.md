# Phase 16 report — Tenders + competitors

Branch: `phase-16/tenders-competitors`  
Date: 2026-11-15  
Base: `phase-15/buying-committee`

This report does **not** enable live tender adapters, auto-submit bids, or fabricated certifications.

## Why this phase

Phase 15 mapped buying committees. Phase 16 adds tender intake (mock sync), bid/no-bid assist with mandatory human decision, and competitor watchlists with versioned battlecards.

## What landed

- **Migration `0020_tenders_competitors.sql`** — tenders, bid assessments, competitors, battlecards; `mock_tenders` source; flags `tenders`, `competitors`.
- **Bid assist** — catalogue/geo/timing heuristics; note states never auto-submit.
- **Battlecards** — sourced claims require evidence; default certifications note forbids fabrication.
- **Web** — Tenders and Competitors pages + nav.

## Checks that ran

| Check | Result |
|---|---|
| Unit `tender-bid` | pass |
| Integration `tenders` | pass |
| Scoped eslint on changed files | pass |
| `tsc` api/web (after freeing local Docker RAM) | pass |
| Full-repo `pnpm lint` | OOM once under memory pressure; scoped lint used |

## Exit criteria

Tenders + competitors vertical slice shipped. Recommended next: **Phase 17 — Proposal studio**.

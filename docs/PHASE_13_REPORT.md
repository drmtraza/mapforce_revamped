# Phase 13 report — Market Opportunity Radar + mission MVP

Branch: `phase-13/opportunity-radar`  
Date: 2026-11-15  
Base: `phase-12/catalogue-matching`

This report does **not** claim Temporal Schedule production wiring, Contabo deploy, D12, Hermes, or buying intent.

## Why this phase

Phase 12 shipped catalogue fit. Phase 13 surfaces a decaying opportunity feed from signals + eligible matches, with mission pause/resume/budget controls for scheduled refresh.

## What landed

- **Migration `0017_opportunity_radar.sql`** — extended signal taxonomy; `market_opportunities`, `radar_missions`, `radar_mission_runs` (+ RLS); flags `opportunity_radar`, `radar_missions`.
- **Decay + dedupe** — freshness half-lives (announcements fastest); fingerprint dedupe; `claim_label` verified_source vs model_inference.
- **API** — feed list/refresh/dismiss; mission CRUD, pause/resume, run-now with daily budget; audit events.
- **Web** — Opportunity radar page + nav.
- **Contracts** — OpenAPI additive; adapter-result signal enum extended (non-breaking).

## Temporal note

Missions store `interval_hours`, `next_run_at`, and nullable `temporal_schedule_id`. Phase 13 run-now refreshes the feed **synchronously**. Registering Temporal Schedules is deferred so worker/dispatcher changes stay additive.

## Checks that ran

| Check | Result |
|---|---|
| Unit `radar-decay` | pass |
| Integration `radar` (decay labels, budget, pause, tenant isolation) | pass |
| lint / typecheck | pass |
| Contabo / packaging-smoke | not run |

## Exit criteria

Radar feed + mission MVP on `phase-13/opportunity-radar`. Recommended next: **Phase 14 — AI gateway + agentic account research** after owner go-ahead.

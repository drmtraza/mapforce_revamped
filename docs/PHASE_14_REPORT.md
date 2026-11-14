# Phase 14 report — AI gateway + account intelligence

Branch: `phase-14/ai-account-research`  
Date: 2026-11-15  
Base: `phase-13/opportunity-radar`

This report does **not** enable Hermes live calls, auto-CRM writes, Contabo deploy, or buying-intent claims.

## Why this phase

Phase 13 surfaced opportunities. Phase 14 adds one-click account intelligence: specialist agents assemble a reviewable draft with quarantine for unsupported sourced claims.

## What landed

- **Migration `0018_account_intelligence.sql`** — `account_intelligence_reports` (+ RLS); flag `account_intelligence`.
- **Gateway** — reuses existing mock/Hermes selector; Hermes still off unless `FEATURE_HERMES` + URL.
- **Orchestrator `account-intel/1.0.0`** — research / signals / matching / evidence_check agents; auditable trace.
- **API** — generate, list, accept/dismiss (CRM unchanged); daily AI budget + workspace AI kill switch.
- **Web** — company IntelPanel one-click generate + review.

## Checks that ran

| Check | Result |
|---|---|
| Unit `agents-orchestrator` | pass |
| Integration `agents` | pass |
| lint / typecheck | pass |

## Exit criteria

Draft account intelligence is available for human review. Recommended next: **Phase 15 — Buying committee + account plans**.

# Phase 15 report — Buying committee + account plans

Branch: `phase-15/buying-committee`  
Date: 2026-11-15  
Base: `phase-14/ai-account-research`

This report does **not** invent reporting lines, assert budget authority without evidence, or auto-write CRM.

## Why this phase

Phase 14 produced reviewable account intelligence. Phase 15 adds stakeholder classifications, coverage scoring, and versioned account plans with manager assignment.

## What landed

- **Migration `0019_buying_committee.sql`** — `buying_committee_members`, `account_plans`; `account_assignments.manager_user_id`; flags `buying_committee`, `account_plans`.
- **Coverage score** — required roles economic_buyer / champion / technical_evaluator / procurement; budget_owner requires evidence.
- **API** — classify/list/dismiss members; create/list/update versioned plans; manager assign syncs to account_assignments.
- **Web** — CommitteePanel on company page.

## Checks that ran

| Check | Result |
|---|---|
| Unit `committee-coverage` | pass |
| Integration `committee` | pass |
| lint / typecheck | pass |

## Exit criteria

Committee + plans vertical slice shipped. Recommended next: **Phase 16 — Tenders + competitors**.

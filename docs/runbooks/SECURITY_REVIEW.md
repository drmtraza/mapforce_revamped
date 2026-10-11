# Security review — Phase 6 as-built

Review date: 2026-10-11  
Scope: code on `phase-6/hardening-scale` relative to Phases 1–5.  
This is an engineering review, not a pentest or legal opinion.

## Findings addressed in this phase

| ID | Item | Treatment |
|---|---|---|
| S1 | Rate limit ran before session resolution, so keys were IP-only | Rate-limit hook is `preHandler`; key is `user:{id}:ws:{workspace}` or `ip:{ip}` |
| S2 | Export/job burst could share the generic 300/min bucket | Separate `RATE_LIMIT_EXPORT_PER_MINUTE` (10) and `RATE_LIMIT_JOB_PER_MINUTE` (30) |
| S3 | No workspace kill switch for research/export/AI | `workspace_controls` + `FEATURE_*` env; global false always wins |
| S4 | One tenant could enqueue unbounded concurrent jobs | `TENANT_CONCURRENT_JOB_LIMIT` (default 8) |
| S5 | `/metrics` tenant leakage | Counters are process-aggregate; no tenant labels |
| S6 | Expired evidence excerpts lingered | Bounded retention sweep redacts excerpts only |

## Already in place (re-verified by existing suites)

- Tenant IDOR → 404 (API + RLS FORCE).
- CSRF header on unsafe methods.
- Helmet CSP default-src none; HSTS in production.
- SSRF blocks on private/link-local/metadata ranges (worker tests).
- CSV formula prefix on export.
- Prompt injection / org-map grounding (Phase 4).
- Contact values encrypted; suppression is hash-only.
- OpenAPI generated; secrets not in repo.
- CI: gitleaks, `pnpm audit --prod --audit-level high`, pip-audit, Trivy CRITICAL/HIGH.

## Open / accepted

| ID | Item | Risk | Disposition |
|---|---|---|---|
| O1 | `/metrics` and `/healthz` are unauthenticated | Info disclosure of process shape | Restrict at ingress in any non-local deploy |
| O2 | No WAF / bot management | Abuse of public login | Deferred with hosting (D13) |
| O3 | Hermes/live providers unevaluated | Data sent to a model host | Remain disabled |
| O4 | D12 licensed contacts disabled | N/A | Leave off |
| O5 | Backup encryption / key custody | Depends on host | Runbook only |
| O6 | No formal threat-model workshop | Residual unknown | Do before Phase 7 beta |

## P0 / P1

None identified in this review that are unmitigated in the current code path. This statement is limited to the automated suites and the review above.

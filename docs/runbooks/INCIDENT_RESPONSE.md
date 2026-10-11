# Runbook — incident response

## Severity

| Sev | Meaning | Example |
|---|---|---|
| P0 | Cross-tenant leak, auth bypass, data deletion | RLS failure, session forge |
| P1 | Outage of core research/API, budget runaway | DB down, Temporal stuck, provider spend |
| P2 | Degraded feature | one source failing, AI quarantine spike |
| P3 | Cosmetic / docs | UI copy |

## First 15 minutes

1. Declare a channel and a single incident lead.
2. Capture `X-Correlation-Id` from the user or `/api/v1/ops/status`.
3. Check `/healthz` (process) vs `/readyz` (DB/Redis).
4. If a provider or feature is burning budget, turn the **global** env kill switch (`FEATURE_RESEARCH=false` etc.) or the workspace switch in Settings → Operations.
5. Do not copy real contact data into tickets. Use tenant UUID and company UUID only.

## Credential revocation

1. Rotate `SESSION_COOKIE_SECRET` (invalidates sessions).
2. Rotate `CONTACT_FIELD_KEY` only with a planned re-encrypt; otherwise contacts become unreadable.
3. Rotate OIDC client secret at the IdP.
4. Revoke provider API keys at the vendor console.
5. Disable the source in `source_registry.enabled`.

## Tenant isolation suspected

1. Freeze exports (`FEATURE_EXPORT=false` or workspace export switch).
2. Do not “fix forward” by writing SQL as a superuser against tenant data.
3. Reproduce with the RLS suite and the API IDOR tests (Bob requesting Alice IDs → 404).
4. Preserve audit_events; they are append-only.

## Communication

Notify affected workspace owners after containment. Do not include contact values, evidence excerpts, or raw logs that may contain PII.

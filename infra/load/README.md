# Load scripts

These k6 scripts are operator tools. They are **not** evidence of 1M users or 10K concurrent sessions.

## Prerequisites

- A running API (`pnpm --filter @mapforce/api dev` against local compose).
- [k6](https://k6.io) installed on the operator machine. CI does not run k6.

## Scripts

| Script | Workload | Auth |
|---|---|---|
| `health.js` | `GET /healthz` and `GET /readyz` | none |

Authenticated list/export load is not scripted here because sessions are cookie+CSRF+OIDC. Use the in-process Vitest harness (`apps/api/test/integration/hardening.test.ts`) for authenticated inject latency.

## Suggested progression

1. 10 VUs / 30s (default).
2. 50 VUs / 2m if the host has spare CPU.
3. Stop. Do not point these scripts at live providers.

Soak (1–4 hours) and 10K-session tests need a dedicated environment (D13) and are not claimed in Phase 6.

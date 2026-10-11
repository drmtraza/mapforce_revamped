# Staging deploy checklist (D13 recommendation)

This is an **operator checklist**, not a claim that a cloud account is provisioned or that capacity is proven.

## Recommended hosting posture (proposed D13)

| Concern | Recommendation | Alternatives |
|---|---|---|
| Compute | Managed containers (Cloud Run / ECS Fargate / Azure Container Apps) | Kubernetes later if needed |
| Postgres | Managed Postgres with PITR + daily backups | Self-hosted only if team already operates it |
| Redis | Managed Redis for rate limits | In-memory only for tiny staging |
| Temporal | Temporal Cloud **or** self-host Temporal on private network | BullMQ only (not preferred) |
| Object storage | Private bucket + short-TTL signed URLs | MinIO/RustFS only for local |
| Identity | Hosted IdP (Clerk/Auth0/Cognito/Entra) or Keycloak | Keep Keycloak only for local |
| Secrets | Cloud secret manager; never bake into images | `.env` files only on developer machines |
| Ingress | TLS terminate; deny public `/metrics` and OpenAPI | VPN/private scrape path for Prometheus |

Owner must still **approve** the cloud vendor; until then treat this as the default blueprint.

## Staging topology

Services to run (same images as local Compose where possible):

1. `api` — Node control plane
2. `api-worker` — Temporal control activities + outbox relay
3. `research-worker` — Python adapters (mocks by default)
4. `web` — Next.js UI
5. Managed Postgres / Redis / object storage / Temporal / IdP

Use `infra/compose/staging.env.example` for env gates, and `pnpm infra:app:up` + `pnpm deploy:smoke` for a **local packaging dry-run** (see `DEPLOY_PACKAGING.md`). That does not replace managed cloud services.

## Required staging env gates

| Variable | Staging value |
|---|---|
| `NODE_ENV` | `production` (or staging with production-like cookie rules) |
| `COOKIE_SECURE` | `true` |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` |
| `EXPOSE_OPENAPI` | `false` |
| `METRICS_TOKEN` | long random (≥16); scrape with `x-metrics-token` |
| `SYNTHETIC_PROBE_TOKEN` | long random; probe with `x-synthetic-token` |
| `FEATURE_MOCK_PROVIDERS` | `true` until live providers approved |
| `FEATURE_LICENSED_CONTACTS` | `false` until D12 |
| `FEATURE_HERMES` | `false` until credentials + eval |
| `DEFAULT_TENANT_PLAN` | `beta` |
| `MAX_BETA_TENANTS` | small (e.g. 5–25) |

## Deploy steps (manual CD until pipeline exists)

1. Build immutable image tags from CI commit SHA.
2. Run migrations as `DATABASE_OWNER_URL` (one-shot job).
3. Roll out `api` → workers → `web`.
4. Smoke: `GET /readyz` → synthetic probe → sign-in → create workspace → company intake.
5. Confirm `/metrics` 404 without token; `/api/v1/openapi.json` 404.
6. Confirm backup snapshot exists before first beta invite.

## Rollback

1. Redeploy previous image tags.
2. Do **not** reverse migrations; restore from PITR/backup if schema must rewind (see `BACKUP_RESTORE.md`).
3. Disable feature flags / workspace kill switches if a provider misbehaves.

## What this does not prove

- 10K concurrent sessions
- Provider yield/cost in production
- RPO/RTO on a specific vendor until measured

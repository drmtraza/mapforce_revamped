# Deploy packaging (cloud-agnostic)

Images and Compose wiring for a packaging dry-run. This does **not** select AWS/GCP/Azure (D13) and does not enable D12.

## Images

| Image | Dockerfile | Default command | Alternate |
|---|---|---|---|
| API | `apps/api/Dockerfile` | `node apps/api/src/server.ts` | `node apps/api/src/temporal/worker-main.ts` (control worker) |
| Web | `apps/web/Dockerfile` | Next standalone server | Bake `API_ORIGIN` at build time |
| Research worker | `workers/research/Dockerfile` | `python -m research_worker.main` | — |

CI builds and Trivy-scans each image on `phase-*/**` and `main`.

Migrations: run the API image once with `node packages/db/src/cli.ts` and `DATABASE_OWNER_URL` (Compose service `migrate`).

## Local packaging stack

```bash
pnpm infra:app:config          # validate merge
pnpm infra:app:up              # infra + migrate + api + api-worker + web
METRICS_TOKEN=local-metrics-token-16 \
SYNTHETIC_PROBE_TOKEN=local-synthetic-token16 \
WEB_BASE_URL=http://localhost:3000 \
pnpm deploy:smoke
pnpm infra:app:down
```

Defaults in `infra/compose/docker-compose.app.yml` use production-like gates (`EXPOSE_OPENAPI=false`, scrape tokens, `COOKIE_SECURE=true`). Browser login against local Keycloak may still need IdP hostname work; smoke does not require login.

## Smoke contract

`infra/deploy/smoke.mjs` asserts:

1. `/healthz` ok  
2. `/readyz` ready  
3. `/metrics` 404 without token; 200 with `x-metrics-token`  
4. `/api/v1/openapi.json` 404  
5. `/synthetic/probe` ok with token  
6. optional `WEB_BASE_URL/login` 200  

## CI packaging smoke

Workflow job `packaging-smoke` (in `.github/workflows/ci.yml`) brings up Compose infra, migrates, starts the API with `EXPOSE_OPENAPI=false` plus scrape tokens, and runs `pnpm deploy:smoke`. That proves the smoke contract on every phase branch without a cloud account.

## GHCR image publish

Workflow `.github/workflows/release-images.yml` pushes `api`, `web`, and `research-worker` to GitHub Container Registry on `main`, `v*` tags, and `workflow_dispatch`:

`ghcr.io/<owner>/<repo>/mapforce-<name>:<git-sha>` (and `:latest` on default branch).

Pull example (after `main` merge):

```bash
docker pull ghcr.io/<owner>/<repo>/mapforce-api:sha-<full-sha>
```

Packages may be private to the GitHub org/user; grant `read:packages` as needed. This is **not** a deploy to AWS/GCP/Azure.

## Cloud next step (after D13 vendor)

Pull the GHCR tags (or mirror them); run `migrate` as a one-shot job; roll api → workers → web; run `deploy:smoke` against the staging URL. See `STAGING_DEPLOY.md` and `docs/adr/D13_HOSTING_RECOMMENDATION.md`.

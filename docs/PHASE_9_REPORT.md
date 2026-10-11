# Phase 9 report — Deploy packaging

Branch: `phase-9/deploy-packaging`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-8/review-refactor` (`4c4a64a`)

This report does **not** claim a cloud account, CD pipeline to production, or scale capacity. D12 stays off. D13 vendor remains an owner choice.

## Why this phase

After Phase 8’s staging blueprint, the next useful step was **cloud-agnostic packaging**: run API + worker + web + migrate as images with a smoke contract, without inventing AWS/GCP/Azure credentials.

## What landed

- **`infra/compose/docker-compose.app.yml`** — migrate one-shot, `api`, `api-worker`, `web` on top of existing Compose infra (Postgres/Redis/Temporal/objectstore/Keycloak/research-worker).
- **Smoke script** — `infra/deploy/smoke.mjs` / `pnpm deploy:smoke` (readyz, metrics token gate, OpenAPI hidden, synthetic probe, optional web `/login`).
- **Image healthchecks** on API and web Dockerfiles.
- **pnpm scripts** — `infra:app:up`, `infra:app:down`, `infra:app:config`, `deploy:smoke`.
- **CI** — `compose-packaging` job validates merged Compose config.
- **Docs** — `docs/runbooks/DEPLOY_PACKAGING.md`; roadmap/plan updated.

## Checks that ran

| Check | Result |
|---|---|
| `pnpm infra:app:config` | passed |
| `pnpm format` / lint / typecheck | passed |
| Full `pnpm infra:app:up` + smoke | not run in this session (operator dry-run; image builds already covered by CI `images` job) |
| API unit / integration / db / python | not re-run (no application logic change beyond packaging) |
| Hosted cloud deploy | not run (D13 open) |

## Remaining limitations

- Browser login through Compose may still need IdP public URL alignment; smoke does not require sign-in.
- No registry push / managed Postgres / Temporal Cloud wiring until D13 is approved.
- D12 licensed contacts still disabled.

## Exit criteria

Packaging path exists: build images, migrate, run api/worker/web, smoke gates. Owner next: choose D13 vendor (then registry + managed services) or D12 procurement if contacts are required.

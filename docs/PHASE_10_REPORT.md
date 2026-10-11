# Phase 10 report — Release smoke and registry

Branch: `phase-10/release-smoke`  
Date: 2026-10-11  
Remote: https://github.com/drmtraza/mapforce_revamped  
Base: `phase-9/deploy-packaging` (`41cdc1e`)

This report does **not** claim a cloud deploy, D13 vendor selection, or production readiness. D12 stays off. GHCR publish is registry-only.

## Why this phase

Phase 9 added packaging artifacts; Phase 10 proves the smoke contract in CI and publishes immutable images to GHCR so a future D13 host can pull tags without inventing cloud IaC yet.

## What landed

- **CI `packaging-smoke`** — Compose infra → migrate → API with `EXPOSE_OPENAPI=false` + scrape tokens → `pnpm deploy:smoke`.
- **`release-images` workflow** — push `api` / `web` / `research-worker` to `ghcr.io/<owner>/<repo>/mapforce-*` on `main`, `v*` tags, and manual dispatch.
- **Docs** — `DEPLOY_PACKAGING.md` updated for CI smoke and GHCR.

## Checks that ran

| Check | Result |
|---|---|
| Local `pnpm deploy:smoke` (Compose infra + gated API) | all six assertions ok |
| `pnpm format` / lint / typecheck | run before push |
| CI packaging-smoke / release-images | will run on remote after push |
| Cloud staging deploy | not run (D13 open) |
| GHCR push | only after merge to `main` or tag / manual dispatch |

## Remaining limitations

- GHCR is not AWS/GCP/Azure; owner still chooses D13.
- D12 licensed contacts remain disabled.
- `release-images` needs package write permission on the repo (default `GITHUB_TOKEN` with `packages: write`).

## Exit criteria

Smoke contract is automated. Images are publishable to GHCR. Next owner decisions unchanged: D13 vendor, then optional D12 procurement.

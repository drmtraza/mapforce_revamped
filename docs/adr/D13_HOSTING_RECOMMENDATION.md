# ADR draft — D13 Hosting cloud & managed services

Status: **Proposed** (owner approval still required)  
Date: 2026-10-11  
Related: `docs/OPERATIONS_AND_COST.md`, `docs/runbooks/STAGING_DEPLOY.md`

## Context

Phases 1–7 implement the product and controlled-rollout controls, but no cloud vendor was chosen. Load, backup, and beta invites cannot be exercised on a production-like host until D13 is decided.

## Decision (recommended)

Adopt a **managed container platform** (not Kubernetes on day one) with:

- Managed PostgreSQL (PITR, automated backups)
- Managed Redis for shared rate limits
- Temporal Cloud **or** Temporal on a private network
- Private object storage for evidence
- Hosted IdP (or Keycloak in a private VPC) behind the existing IdP adapter
- Secret manager for all credentials
- Ingress TLS; scrape tokens for `/metrics` and `/synthetic/probe`; OpenAPI off on public edge

Vendor choice among AWS / GCP / Azure is left to the owner; the topology above is portable.

## Consequences

- Staging can follow `STAGING_DEPLOY.md` without rewriting the app.
- D12 licensed contacts and Hermes remain separately gated.
- This ADR does **not** assert 99.9% availability or 10K concurrent capacity.

## Alternatives considered

- Kubernetes-first: deferred until operational need is proven.
- Self-hosted Postgres/Temporal only: higher ops burden for MVP beta.

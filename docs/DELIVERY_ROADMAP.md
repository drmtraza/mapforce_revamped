# Delivery Roadmap and Definition of Done

## Phase 0 — Repository and decision baseline
Deliver:
- Confirmed requirements, ADRs, threat model, provider/source policy.
- System context diagram, API contract baseline, schema and migration strategy.
- Backlog, dependency map and measurable acceptance criteria.
Exit criteria: product owner approves architecture and MVP boundary.

## Phase 1 — Foundation and vertical slice
Implement:
- Repository structure, CI, lint/typecheck, Docker local environment.
- Authentication integration, workspace/tenant model, RBAC.
- PostgreSQL migrations, audit events, OpenAPI and API error contract.
- Mock provider adapter, job lifecycle, source evidence persistence.
- Company intake and review UI.
Exit criteria: tenant A/B isolation tests pass; user submits a company and sees evidence + audit trail.

## Phase 2 — Discovery and evidence
Implement:
- CSV/manual import with dry-run and deduplication.
- Source registry and adapter interface.
- One permitted search/discovery API and public company-site crawler.
- Crawl policy, domain budgets, SSRF defense, source freshness.
- Partial success, retries, cancellation and dead-letter handling.
Exit criteria: provider failure is isolated; evidence provenance is inspectable.

## Phase 3 — People, enrichment and signal detection
Implement:
- Candidate people and role history.
- Careers/job-board signal adapter and one additional source based on target geography.
- One licensed contact provider adapter, disabled until credentials/terms approved.
- Contact quality statuses and budget-aware waterfall.
- Human review, merge/split and conflict resolution.
Exit criteria: no field is labelled verified without a documented method/source.

## Phase 4 — Organization mapping and AI
Implement:
- Hermes/model provider abstraction.
- Strict JSON schema validation and evidence-ID references.
- Role taxonomy, persona mapping, cautious relationship inference and outreach drafts.
- Prompt-injection test suite, token budgets, model audit metadata.
Exit criteria: AI outputs pass factuality/evidence evaluation on labelled set; unsupported claims are surfaced.

## Phase 5 — BD workspace and monetization
Implement:
- ICP builder, explainable scoring, saved lists, ownership, tasks, notes and pipeline.
- Suppression lists, controlled export, usage metering and admin budgets.
- Billing/plan integration only after pricing and packaging are approved.
Exit criteria: suppression is enforced across lists, exports and drafts; usage is auditable.

## Phase 6 — Hardening and scale
Implement:
- Load/soak/failure-injection tests.
- Database/index tuning, pooling, autoscaling and queue fairness.
- Backup restore, incident response, dashboards, alerts and runbooks.
- Security review and privacy/retention verification.
Exit criteria: published test report documents supported workload and remaining constraints.

## Phase 7 — Controlled production rollout
- Limited beta tenants, synthetic monitoring and feedback loop.
- Feature flags and provider budget ceilings.
- Data-quality review and incident triage.
- Gradual quota increase based on observed capacity and provider permissions.

## Phase 8 — Review, refactor and deployability
- Review against PRD acceptance criteria and project rules; fix highest-risk gaps first.
- Bound heavy reads; gate metrics/OpenAPI; extend isolation/RLS coverage.
- Document D13 hosting recommendation and staging deploy checklist (no cloud credentials required).
- D12 licensed contacts remain disabled until procurement/terms approval.

## Phase 9 — Deploy packaging
- Wire API / worker / web / migrate into Compose for a packaging dry-run.
- Image healthchecks and post-deploy smoke script (readyz, metrics/OpenAPI gates, synthetic probe).
- CI validates merged Compose config; existing image build/scan remains.
- Still cloud-agnostic; D13 vendor and D12 remain owner decisions.

## Definition of done for every phase
- Acceptance criteria met.
- Tests added and executed.
- No secrets or real contact data in repository.
- Migrations and rollback/forward recovery documented.
- Logs, metrics and failure handling implemented.
- User-facing empty/error/loading/partial-success states handled.
- Docs updated to match actual implementation.
- Cursor reports exactly what ran and what did not.

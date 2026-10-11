# Operations, Deployment and Cost Governance

## 1. Environments
- `local`: Docker Compose, mock providers, seeded synthetic data.
- `test`: isolated database, provider stubs, CI integration tests.
- `staging`: production-like topology, synthetic data, limited sandbox integrations.
- `production`: managed database, durable workflow service, private worker network, secrets manager, object storage, monitoring and backups.

Never copy real prospect/contact datasets into local fixtures or issue trackers.

## 2. Deployment baseline
- Containerize API and each worker class.
- CI: lint, typecheck, unit/integration/contract tests, dependency scan, secret scan, build and image scan.
- CD: immutable image tags, migrations as controlled jobs, staged rollout, smoke tests and rollback plan.
- Use managed PostgreSQL with backups/PITR, connection pooling and monitored replicas as needed.
- Redis managed or isolated with persistence/HA appropriate to its role.
- Store evidence in private object storage with lifecycle and signed access URLs.
- Run crawlers in isolated worker network with restricted egress; never mount application secrets into crawl containers.
- Keep internal AI endpoint private; require authentication and request budgets.
- Local AI defaults: `FEATURE_HERMES=false` (mock org-map). Set `FEATURE_HERMES` and `HERMES_BASE_URL` only after credentials exist. Bound spend with `TENANT_DAILY_AI_RUN_LIMIT`, `AI_MAX_TOKENS` and `AI_TIMEOUT_MS`.

## 3. Observability
Metrics:
- API request rate, p50/p95/p99 latency, error rate.
- DB pool wait, slow queries, lock time, CPU/IO and replication lag.
- Queue depth/age, job duration, retries and dead letters.
- Per-provider latency, errors, rate limits, quota and cost.
- Crawl pages, bytes, blocked/error rate, extraction yield.
- AI tokens, latency, schema failure, cost and unsupported-claim evaluation.
- Per-tenant usage and estimated/actual cost.
Logs must be structured, redacted and correlated. Traces should cross API → workflow → worker → provider/AI boundary.

## 4. Cost model
Do not hard-code costs from the supplied discussion as facts. The attachment's estimates (including approximately $6.40 per 1,000 mapped accounts) are planning hypotheses only; they depend on provider pricing, coverage, retries, GPU utilization, source mix and what counts as a mapped account.

For each provider/job, record:
- calls, units/credits, pages, tokens, elapsed time, retries, estimated cost, actual billed cost where available, result yield and failure reason.
- cost per discovered company, candidate person, enriched contact, evidence-backed qualified lead and completed org map.
- cache hit rate and duplicate work avoided.

## 5. Cost controls
- Tenant and plan quotas.
- Per-job max companies, pages, contacts, tokens and wall-clock duration.
- Waterfall enrichment: free/low-cost permitted sources first; paid enrichment only when ICP relevance and user policy justify it.
- Require provider budget before job execution; stop or return partial result at budget ceiling.
- Deduplicate before paid enrichment.
- Cache provider results only within contractual and freshness constraints.
- Batch provider requests where permitted.
- Use deterministic scoring to filter candidates before LLM calls.
- Local model inference is not free: include GPU rental, idle capacity, maintenance and model operations.
- Admin kill switch per provider, source type, tenant and AI model.

## 6. Provider onboarding checklist
- Contract/terms and permitted use reviewed.
- Data coverage and geography measured.
- API schema and quota confirmed.
- Rate limits and retries documented.
- PII/security assessment complete.
- Test fixtures and contract tests created.
- Cost and expected yield measured.
- Fallback behavior and kill switch implemented.
- Retention/deletion requirements documented.

# B2B Lead Intelligence & Business Development Mapping Platform
## Cursor AI implementation kit

This repository kit turns the attached discovery discussion and proposed polyglot architecture into implementation artifacts for a commercial SaaS product.

### Product objective
Discover target organizations from permitted public sources and licensed providers; identify relevant business contacts; corroborate current roles; detect commercial intent signals; construct evidence-backed organization maps; prioritize accounts; and support human-reviewed business development workflows.

### Scale objective
Design for 1,000,000 registered users and 10,000 concurrent users. These are design targets, not proof of capacity. They must be validated through workload modelling, production-like load tests, and staged capacity reviews.

### Running the platform locally (Phase 2)
Requirements: Docker, Node.js ≥ 22.18 with Corepack, and `uv` (only to run the Python worker's checks outside Docker). No provider credentials are needed; all data is synthetic.

```bash
corepack enable && pnpm install
cp .env.example .env                 # local placeholders only
pnpm infra:up                        # Postgres, Redis, Temporal, RustFS, Keycloak, research worker
pnpm db:migrate
pnpm --filter @mapforce/api dev      # API on :4000
pnpm --filter @mapforce/api worker   # control worker + outbox relay
pnpm --filter @mapforce/web dev      # UI on http://localhost:3000
```

Sign in with the synthetic users `alice@tenant-a.test` / `alice-local-only` or `bob@tenant-b.test` / `bob-local-only` (dev realm only). If default host ports clash with other services, export `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `S3_HOST_PORT` etc. before `pnpm infra:up` and adjust the URLs in `.env`.

After sign-in: Companies, Discovery (reviewable search candidates), Imports (CSV dry-run then commit), source Settings (crawler opt-in; Brave stays off), Audit trail. Checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` (Docker required), `pnpm --filter @mapforce/web test:e2e` (against the running stack), and in `workers/research`: `uv run ruff check . && uv run mypy && uv run pytest`. Phase evidence: `docs/PHASE_1_REPORT.md`, `docs/PHASE_2_REPORT.md`.

### Artifact map
- `prompts/MASTER_CURSOR_PROMPT.md` — paste into Cursor as the project-level execution brief.
- `docs/PRODUCT_REQUIREMENTS.md` — personas, scope, workflows, functional requirements and acceptance criteria.
- `docs/ARCHITECTURE.md` — target architecture and component decisions.
- `docs/DATA_MODEL.md` — canonical entities, provenance, deduplication, tenancy and retention.
- `docs/API_AND_EVENT_CONTRACTS.md` — API boundaries, event envelope, idempotency and service contracts.
- `docs/AI_AGENT_SPEC.md` — Hermes/LLM responsibilities, grounding, confidence, safety and output schema.
- `docs/SECURITY_PRIVACY_COMPLIANCE.md` — security baseline and responsible data acquisition.
- `docs/DELIVERY_ROADMAP.md` — phased delivery sequence and definition of done.
- `docs/QUALITY_AND_SCALE_PLAN.md` — test strategy, SLOs, load profile and capacity validation.
- `docs/OPERATIONS_AND_COST.md` — deployment, observability, provider abstraction and cost governance.
- `contracts/lead.schema.json` and `contracts/org-map.schema.json` — starter JSON schemas.
- `.cursor/rules/00-project.mdc` — persistent Cursor project rules.
- `skills/b2b_org_deducer/SKILL.md` — Hermes skill specification.
- `prompts/PHASE_PROMPTS.md` — focused prompts to execute one phase at a time.

### How to use
1. Create/open an empty Git repository in Cursor.
2. Copy this kit into the repository root.
3. Read the master prompt and project rules.
4. Ask Cursor to inspect the artifacts and produce an implementation plan before writing application code.
5. Implement one phase at a time. Require tests and a working vertical slice before advancing.
6. Keep provider credentials in secrets/environment configuration; never commit credentials.
7. Treat all vendor prices, provider coverage, source permissions and throughput estimates as unverified until measured against current plans, contracts and tests.

### Important architecture decisions
- Start with a **modular monolith for the control plane** plus independently deployable worker services. Extract services only where load, ownership or failure isolation justifies the operational cost.
- Use PostgreSQL as the authoritative transactional store. Add Neo4j only when graph traversal requirements justify its operational cost; begin with relational edges or a graph adapter if the first release can meet latency targets without it.
- Use durable workflow orchestration (Temporal is preferred for long-running multi-step workflows); Redis may be used for cache/rate limiting and BullMQ for simpler Node-centric queues. Do not treat Redis alone as the sole durable source of business truth.
- Keep discovery, crawling, contact enrichment, verification and LLM reasoning separate.
- Prefer official APIs, licensed data providers, permitted search APIs and public company sites. Do not build anti-bot evasion or unauthorized authenticated scraping.
- Do not assume direct SMTP `RCPT TO` checks reliably verify inboxes. Many providers block or deliberately obscure responses. Use provider-supported verification and represent uncertainty explicitly.
- AI must not invent contacts, reporting lines, buying intent, or source evidence. Store citations/provenance for every material claim.

### Initial deployment posture
Use managed PostgreSQL, managed Redis/queue where appropriate, object storage for crawl artifacts, containerized workers, centralized logs/metrics/traces, secrets management, WAF/rate limiting, and automated backups. Kubernetes is not mandatory on day one; choose a managed container platform first unless the team already operates Kubernetes well.

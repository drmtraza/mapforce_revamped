# Target Architecture and Decision Records

## 1. Recommended architecture
Use a **modular SaaS control plane plus event-driven data workers**. Do not begin with dozens of microservices. Deploy clear module boundaries, then extract services based on measured throughput, independent scaling needs or failure isolation.

```text
Browser / PWA (Next.js)
        |
 CDN + WAF + rate limits
        |
 API / BFF (TypeScript, Fastify or NestJS; versioned REST)
        |
 Application modules: Identity/Tenant, ICP, Accounts, People, Signals,
 Evidence, Scoring, CRM Workflow, Usage, Audit, Admin
        |
 PostgreSQL (canonical source of truth) ---- Object storage (crawl artifacts)
        |                                           |
 Transactional outbox                              |
        |                                           |
 Durable workflow orchestration (Temporal preferred)
        |
 Queue / worker pools
   |           |            |              |
Discovery   Crawl &      Enrichment     AI reasoning
adapters     parsing      adapters       (Hermes/LLM)
   |           |            |              |
Search APIs   Public       Licensed       Structured output
Public        company      B2B APIs        + evidence IDs
registries    sites
Careers       Procurement
   \           |            |              /
        Normalization, entity resolution, provenance
                         |
       PostgreSQL canonical entities + optional Neo4j projection
                         |
             Search index/cache (optional, derived only)
```

## 2. Recommended stack and rationale
### Frontend
- Next.js + React + TypeScript.
- Responsive, accessible account workspace; server-rendered public pages only where appropriate.
- TanStack Query or equivalent for client cache; schema-driven forms; table virtualization for large lists.
- Do not load million-row datasets into the browser; use server-side filtering and cursor pagination.

### Core API/control plane
- TypeScript + Fastify (or NestJS if stronger opinionated module conventions are preferred).
- REST/JSON with OpenAPI as the source of API documentation. Avoid GraphQL and gRPC-Web initially unless concrete use cases justify them.
- Strict request validation, authentication middleware, authorization policy layer, idempotency support and tenant context propagation.

### Workflow orchestration
- Temporal for multi-step durable workflows, timers, retries, compensation and replay.
- BullMQ/Redis can be sufficient for an early Node-only queue, but do not duplicate orchestration responsibilities. Select one primary workflow approach.
- Transactional outbox ensures committed database changes and published events remain consistent.

### Discovery/crawl workers
- Python 3.11+ with asyncio, Playwright/Crawl4AI where permitted, parsers and provider-specific adapters.
- Use official provider APIs and documented endpoints first. Use public company sites and search providers under their terms.
- Respect robots.txt and source terms; identify the crawler where appropriate; apply per-domain concurrency and rate limits.
- Store a compact normalized representation and content hash; raw HTML retention should be minimized and policy-controlled.

### High-throughput utilities
- Go only where profiling shows a benefit for high-concurrency parsing or network I/O. Avoid a Go microservice solely because Go can handle many sockets.
- Direct SMTP probing is not a default strategy: provider responses are often inconclusive, port 25 is frequently blocked, and aggressive probing can harm reputation. Use compliant email verification providers and explicit uncertainty states.

### AI reasoning
- Python service using Hermes Agent where agentic tool use and persistent skills provide value; alternatively call a model through a provider abstraction.
- LLM receives only normalized, minimized evidence. Tool execution is allowlisted and server-authorized.
- Prefer deterministic rules for normalization, scoring and suppression; use LLM for ambiguous classification, synthesis and draft generation.
- Run local inference only after comparing GPU utilization, ops overhead, latency, quality and cost against hosted models.

### Storage
- PostgreSQL 16+ (or current supported managed version): canonical tenant, company, people, contact, evidence, signal, workflow, usage and audit data.
- Object storage (S3-compatible): compressed crawl evidence and exports with retention lifecycle.
- Redis: caching, rate limits, ephemeral coordination and queue support only where needed.
- Neo4j: optional graph projection for advanced org traversal. Begin with PostgreSQL relationship tables and benchmark. Avoid dual-write inconsistency: publish graph updates via outbox/worker and support rebuild.
- Search engine (Postgres full-text first; OpenSearch/Meilisearch later if justified) is a derived index, never canonical truth.

## 3. Source adapter pattern
Each adapter implements a shared interface:
- `discoverCompanies(query, budget, cursor?)`
- `discoverPeople(company, roleFilters, budget)`
- `fetchCompanyEvidence(companyRef, allowedPages)`
- `fetchIntentSignals(companyRef, window)`
- `enrichContact(candidate, requestedFields, budget)`
- `healthCheck()`
Return normalized results with source ID, provider, fetched time, source URL/reference, field provenance, confidence/status and usage cost where available.

Initial adapters should be mockable and independently feature-flagged:
1. Manual/CSV import.
2. Official/public registry API appropriate to target geography.
3. Permitted search API for public profile discovery.
4. Public company website/careers crawl.
5. One licensed contact enrichment provider (e.g. Apollo or a selected alternative after procurement/compliance review).
6. Optional domain/email verification provider.
7. Procurement/tender and funding/news providers based on target market.

Provider abstraction must not disguise non-compliant collection. The same legal/source policy applies regardless of adapter.

## 4. Workflow example: map one target company
1. User submits company/domain; validate domain and tenant quota.
2. Upsert an idempotent discovery job and return job ID.
3. Resolve company identity/domain; store initial evidence.
4. Fan out permitted discovery, company-site crawl, careers/jobs, public registries and configured intent sources.
5. Normalize names, roles, domains and signal dates; deduplicate candidates.
6. Apply cheap deterministic filters and ICP scoring.
7. Enrich only candidates above threshold or explicitly selected by the user.
8. Verify contacts through permitted provider; never infer verification from format/MX alone.
9. Call Hermes for organization-role mapping and evidence-grounded outreach hooks.
10. Validate model output against schema; persist inference separately from source facts.
11. Update PostgreSQL transactionally and emit outbox events; update optional graph projection asynchronously.
12. Notify UI; expose partial failures, freshness and costs; user reviews and approves records.

## 5. Reliability patterns
- At-least-once delivery with idempotent consumers; do not promise exactly-once delivery.
- Unique idempotency keys for imports, provider requests and job steps.
- Exponential backoff with jitter; bounded retries; circuit breakers and provider-specific concurrency.
- Dead-letter queue with replay tooling and reason codes.
- Partial-success model: one failed source must not discard valid evidence from other sources.
- Timeouts and budgets on every external call and AI run.
- Per-tenant and per-provider token buckets; global emergency kill switch.
- Versioned workflow definitions and safe migration/replay plan.

## 6. Multi-tenancy
- Every tenant-owned row includes `tenant_id` except explicitly global reference data.
- PostgreSQL row-level security may provide defense in depth; application authorization remains required.
- Composite indexes begin with `tenant_id` for common access paths.
- Tenant context must be propagated to background jobs and object-storage keys.
- Avoid shared cache keys without tenant identity.
- Test cross-tenant access across API, exports, background tasks, search indexes, caches and graph projections.

## 7. Scale design
1M registered users does not imply 1M active sessions; 10K concurrent sessions requires explicit request mix and workload modelling.
- Stateless web/API instances behind load balancers.
- Separate autoscaling worker pools by job class (crawl, discovery, enrichment, AI).
- Pool database connections; use PgBouncer/managed pooling where appropriate.
- Cursor pagination and indexed filtering.
- Cache stable reference data and expensive repeated company lookups with freshness/permission-aware keys.
- Partition high-volume event/audit tables only after metrics justify it.
- Use object storage for bulky evidence; avoid large blobs in hot transactional tables.
- Apply queue backpressure, quotas and per-tenant fairness.
- Benchmark PostgreSQL, worker concurrency and provider quotas independently.
- Start with managed containers; Kubernetes is a choice, not a requirement.

## 8. Architecture decisions (ADRs)
- ADR-001: Modular monolith for control plane; separate workers.
- ADR-002: PostgreSQL is canonical; graph/search are derived projections.
- ADR-003: Durable workflow orchestration for long-running research jobs.
- ADR-004: Provider adapters and mock mode required from day one.
- ADR-005: Evidence provenance is mandatory for material data claims.
- ADR-006: Public/authorized source acquisition only; no anti-bot evasion.
- ADR-007: Human approval before outreach; suppression overrides all ranking.
- ADR-008: Validate scale by tests; capacity is not inferred from architecture diagrams.

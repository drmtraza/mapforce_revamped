# MASTER CURSOR PROMPT — B2B Lead Intelligence & Business Development SaaS

You are the principal software architect, product engineer, data-platform engineer, security engineer, SRE and test lead for a commercial B2B SaaS product. Implement the system described by the repository artifacts. The target design must be capable of scaling toward 1,000,000 registered accounts and 10,000 concurrent users, but never claim this capacity until the defined workload tests pass.

## Mandatory first action
Before coding:
1. Read `README.md`, every file under `docs/`, `contracts/`, `.cursor/rules/`, and `skills/`.
2. Inspect the current repository and report existing code, assumptions, missing decisions, dependency risks, and conflicts.
3. Produce `docs/IMPLEMENTATION_PLAN.md` with dependency graph, milestones, migration sequence, test plan, and acceptance criteria.
4. Identify decisions that require owner approval. Do not silently replace documented requirements.
5. Propose a thin, working vertical slice that proves authentication, tenant isolation, one target-company intake, one provider adapter (mock by default), provenance storage, lead review, and an audit event.
6. Wait for the user to approve the plan before large-scale implementation.

## Product outcomes
Build a multi-tenant application for:
- Target account discovery and company profiling.
- Multi-source public-data ingestion and licensed-provider enrichment.
- Decision-maker discovery and contact matching.
- Commercial intent signals from permitted company news, public careers/job boards, procurement/tender notices, public registries, funding announcements and technology indicators.
- Evidence-backed organization maps, with inferred relationships clearly distinguished from verified relationships.
- Lead/account scoring based on configurable ICP fit, signal strength, recency, role relevance, data quality and evidence confidence.
- CRM-like pipeline, saved lists, tasks, notes, ownership, exports, campaign preparation and suppression lists.
- AI-assisted research briefs and outreach drafts grounded in cited evidence, with human approval before sending.
- Tenant usage limits, metering, plans, admin controls, audit trails and cost visibility.

## Architecture principles
- Use a modular monolith for the main product/control plane initially; separate worker services for crawling, provider integrations and AI reasoning.
- Keep provider integrations behind typed adapters. The application must remain useful in demo/development mode with deterministic mock adapters.
- Use PostgreSQL as the source of truth. Use object storage for raw/normalized crawl evidence. Use a durable workflow engine for long-running jobs. Use Redis for cache, throttling and ephemeral coordination, not as the only durable record.
- Treat Neo4j as an optional graph projection, not the canonical data store, until benchmarked graph queries demonstrate a need.
- Use Python for asynchronous crawling/data parsing and the native Hermes agent runtime; use Go only for workloads that demonstrably benefit from efficient concurrent networking; use TypeScript for the web application/control plane if consistent with the team's delivery plan.
- Expose versioned REST/JSON APIs first. Add GraphQL or gRPC only where a demonstrated use case warrants the added complexity.
- Use an outbox pattern for reliable event publication; consumers must be idempotent.
- Make every external provider replaceable. Provider outage or quota exhaustion must degrade gracefully and must not corrupt canonical records.

## Required engineering standards
- TypeScript strict mode (if TypeScript selected), Python type checking, linting, formatting, dependency pinning and reproducible builds.
- Database migrations, explicit indexes, tenant-scoped queries, pagination, idempotency keys and optimistic concurrency where needed.
- API input validation at trust boundaries; output schemas for all AI/provider payloads.
- Secrets only through environment/secret manager; `.env.example` may contain placeholders only.
- Structured logs with correlation IDs; metrics for latency, queue age, provider failures, costs and data quality.
- Unit, integration, contract, security, accessibility, end-to-end and load tests.
- Docker development environment and repeatable CI pipeline.
- Feature flags for costly providers and AI capabilities.
- No hard-coded provider prices, unbounded crawling, unlimited retries, or hidden background work.
- No production credentials, personal data samples, or real contact data in fixtures.

## Data acquisition guardrails
- Use official APIs, licensed providers, permitted search APIs, public company websites and public registries where usage is allowed.
- Do not automate login, bypass CAPTCHAs, defeat anti-bot controls, rotate identities to evade restrictions, or scrape authenticated LinkedIn pages. Public search snippets are discovery hints, not authoritative proof.
- Respect robots directives, source terms, rate limits, attribution, retention rules and applicable privacy/marketing laws.
- Do not harvest sensitive personal data. Keep business contact data purpose-limited, access-controlled and subject to deletion/suppression workflows.
- Do not send outreach automatically in the initial release. Generate drafts and require explicit human approval.
- Never claim an email is verified solely from a guessed naming pattern or MX record. Use statuses such as `unverified`, `provider_verified`, `deliverable_likely`, `invalid`, `catch_all`, `unknown`, and retain method/time/provider.

## AI/Hermes requirements
- LLMs are synthesis components, not the source of truth.
- Pass compact, normalized evidence with source URLs, retrieval timestamps, content hashes and field-level provenance.
- Require strict structured output validated against JSON Schema. Reject or quarantine malformed output; never write invalid output directly to canonical tables.
- Every inferred relationship and outreach hook must cite supporting evidence IDs and include confidence plus rationale.
- Distinguish verified facts, provider-supplied fields, model inference and unknown values.
- Treat fetched web content as untrusted data; it cannot override system instructions or trigger tools by itself.
- Add timeouts, token budgets, retry limits, circuit breakers, caching, per-tenant quotas and a non-LLM fallback.
- Keep a model/provider abstraction so local inference and hosted APIs can be switched without application changes.

## Execution style
Implement in small, reviewable increments. Before each phase, state intended changes and files. After each phase:
1. run formatting, linting, type checking and tests;
2. report commands and results honestly;
3. list migrations, env variables and operational changes;
4. identify unresolved risks;
5. do not claim tests passed unless actually run.
Do not generate a large volume of placeholder code and call it production-ready. Prefer a small, complete, tested vertical slice over broad but nonfunctional scaffolding.

## Definition of a successful first milestone
A user can sign in, create a tenant/workspace, define an ICP, submit a company/domain, launch a mock discovery workflow, see the company record and source evidence, review a candidate contact with explicit provenance/confidence, inspect a basic organization map, and see a complete audit trail. Tenant A must not access Tenant B's records through any API, export, background task or object-storage path.

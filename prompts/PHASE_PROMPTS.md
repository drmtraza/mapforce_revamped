# Cursor Phase Prompts

Use one prompt at a time. Ask Cursor to inspect repository state and report results honestly.

## Prompt 0 — Plan only
Read all project artifacts. Do not modify code yet. Produce `docs/IMPLEMENTATION_PLAN.md` with modules, dependency graph, repository layout, schema plan, APIs, risks, test strategy, and phase acceptance criteria. Flag contradictions and decisions needing approval. Do not assume provider credentials exist.

## Prompt 1 — Foundation
Implement Phase 1 from `docs/DELIVERY_ROADMAP.md`. First propose file-level changes. Build authentication/workspaces/RBAC, tenant-scoped persistence, audit trail, OpenAPI, mock research provider and a single end-to-end company intake flow. Include migrations and tests. Run all available checks and report exact outcomes.

## Prompt 2 — Discovery adapters
Implement source registry and adapter interface, CSV import, one permitted search API adapter behind configuration, and public company-site crawler. Add domain allow/deny rules, SSRF protections, per-domain rate limits, source evidence and partial-success workflow. Default to mock adapters without credentials. Do not bypass access controls.

## Prompt 3 — People and contact enrichment
Implement canonical people, employment roles, candidate matching, field-level provenance and contact status model. Add one licensed-provider adapter only behind a feature flag. Never mark guessed addresses as verified. Add human review/merge/split workflows and tests.

## Prompt 4 — Signals and scoring
Implement hiring/news/procurement signal adapters according to approved source policy. Add versioned ICP profiles and explainable 0–100 score. Apply suppression/exclusion rules before any recommendation. Include recency and source-quality tests.

## Prompt 5 — Hermes/AI
Implement the AI service abstraction and Hermes adapter. Use the skill in `skills/b2b_org_deducer/SKILL.md`. Input only compact evidence records and source IDs. Validate structured output against `contracts/org-map.schema.json`. Add prompt injection tests, token/time budgets, timeouts, retries, evidence validation and deterministic fallback.

## Prompt 6 — BD workspace
Implement account assignment, stages, tasks, notes, evidence timeline, research dossier, outreach draft generation, suppression management and controlled exports. Ensure human approval is mandatory and exports are audited.

## Prompt 7 — Production hardening
Implement operational dashboards/metrics, provider budget limits, rate limits, backups/restore instructions, dependency/security scanning, E2E suite, load tests and runbooks. Do not claim 10K concurrent capacity until a report shows the workload, environment, results and bottlenecks.

## Prompt 8 — Review and refactor
Review code against every acceptance criterion in the PRD and project rules. Identify dead code, placeholders, missing tests, unbounded operations, tenant-isolation risks, schema drift, accessibility gaps and undocumented env variables. Fix the highest-risk issues first. Report remaining limitations without overstating readiness.

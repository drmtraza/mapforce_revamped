# Product Requirements Document (PRD)

## 1. Product vision
Provide a trustworthy B2B intelligence workspace that helps business development teams decide **which organizations to approach, whom to contact, why now, and what evidence supports the recommendation**. The product is not merely a scraper or a bulk contact dump.

## 2. Primary user groups
- Workspace owner / administrator: configures team, plans, integrations, budgets and data policy.
- Business development representative: researches accounts, reviews contacts, prioritizes work and prepares outreach.
- Sales/BD manager: configures ideal customer profiles (ICPs), assigns accounts, monitors pipeline and team performance.
- Research analyst: checks source evidence, resolves entity ambiguity and reviews organization maps.
- Platform operator: manages provider health, queues, usage, abuse prevention and tenant support.

## 3. Core user journeys
1. Create workspace → invite team → set ICP and geography/industry filters.
2. Import company list or enter domains → normalize and deduplicate companies.
3. Discover public company context and potential people via permitted source adapters.
4. Detect current intent signals and preserve the underlying source evidence.
5. Enrich only high-priority targets through licensed providers according to tenant budget and provider permissions.
6. Review candidate people, current employment evidence, contact quality and inferred organization links.
7. View account dossier, decision-making unit and evidence timeline.
8. Score and rank accounts/contacts with explainable factors.
9. Save to list, assign owner, create task and draft personalized outreach.
10. Human reviews the draft and source evidence before any export or send action.
11. Suppress a contact/domain, request deletion, export records or inspect audit history.
12. Admin reviews usage, spend, provider quotas, data freshness and job failures.

## 4. Functional modules
### 4.1 Workspace and identity
- Authentication through a maintained identity provider or secure first-party auth implementation.
- Organizations/workspaces, membership, roles, invitations and session management.
- RBAC: owner, admin, manager, researcher, representative, read-only/auditor.
- Tenant isolation enforced at database/service boundaries, not merely in the UI.
- Workspace-level configuration, billing/plan limits and usage meters.

### 4.2 ICP and account targeting
- ICP builder: industry, geography, size band, revenue band where sourced, technologies, business model, hiring/funding/procurement signals, exclusions and target personas.
- Saved searches and reusable target lists.
- CSV import with validation, deduplication report and dry-run preview.
- Search filters must disclose which fields are sourced, inferred or unavailable.

### 4.3 Company discovery and enrichment
- Normalize company name, domain, country/region, industry, size estimate and aliases.
- Source adapters for official public registries, company websites, public careers pages, permitted search APIs, procurement portals and licensed B2B providers.
- Optional LinkedIn public search-index references may be retained as discovery evidence only when the source provider's terms permit the use.
- Record source URL, source/provider name, retrieval time, content hash, license/terms metadata where applicable, and field-level provenance.
- Merge duplicates using normalized domain, registry identifier, aliases and reviewed match candidates.
- Keep historical values with valid-from/valid-to timestamps rather than silently overwriting material changes.

### 4.4 Intent signal engine
Signal types: hiring, funding, procurement/tender, expansion, leadership change, product launch, technology footprint, regulatory filing and relevant news.
Each signal must contain: type, summary, observed time, publication time if available, source evidence, freshness/expiry policy, confidence, company link and relevance explanation.
Do not equate hiring with confirmed budget. Present signals as evidence of possible initiative, not certainty.

### 4.5 People and contact resolution
- Candidate discovery from public company leadership/team pages, official filings, licensed contact providers and permitted search endpoints.
- Canonical person records, aliases, role history, company association, public profile URL and source evidence.
- Contact fields are separate from person identity. Store work email/phone only where lawfully obtained and supported by a source/provider.
- Email status values: `unverified`, `provider_verified`, `deliverable_likely`, `invalid`, `catch_all`, `unknown`, `suppressed`.
- Never treat an inferred email pattern as verified.
- Track last-verified time and verification method; refresh according to configurable TTL.
- Deduplicate across sources; preserve source-specific records and conflicting claims for review.

### 4.6 Organization mapping
- People, roles, departments and companies form a graph of relationships.
- Relationship types include `WORKS_AT`, `HOLDS_ROLE`, `REPORTS_TO`, `INFLUENCES`, `DECIDES_FOR`, `USES_TECHNOLOGY`, `HIRING_FOR`, and `EVIDENCED_BY`.
- Each relationship has evidence, source, confidence, status (`verified`, `inferred`, `disputed`, `expired`) and valid dates.
- UI visually distinguishes verified and inferred edges.
- Do not infer a reporting line from seniority alone and present it as fact.

### 4.7 Scoring and recommendations
Provide configurable, explainable scoring:
- ICP fit (0–30)
- role/decision-unit relevance (0–20)
- intent signal strength and recency (0–20)
- data completeness/quality (0–15)
- source corroboration/confidence (0–15)
Total 0–100. Weights are editable per workspace and must be versioned. Avoid false precision; show factor contributions and evidence. Exclusions and suppression always override score.

### 4.8 BD workspace / lightweight CRM
- Account and contact lists, tags, owner, status, tasks, notes, activity timeline, next action and source dossier.
- Stages configurable per workspace.
- Saved searches, bulk actions with preview, CSV export with permissions and audit.
- Draft emails/messages and call briefs based on cited evidence.
- Initial release is human-in-the-loop: no automatic sending or automated contact sequence execution.
- Suppression and unsubscribe state enforced across exports and future workflows.

### 4.9 AI research assistant
- Ask questions about an account using only available, cited evidence.
- Summarize why an account may be relevant and which stakeholder roles may matter.
- Generate outreach angles, not fabricated personal familiarity.
- Clearly mark unknowns and conflicts.
- User can inspect source evidence behind each material statement.

### 4.10 Admin and operations
- Provider credentials, quota/budget limits, rate limits and circuit-breaker status.
- Job queue status, retry/dead-letter review, source health and data freshness.
- Usage by tenant/provider/job type; cost ceilings and alerts.
- Audit logs, retention/deletion workflows and suppression list management.
- Feature flags for external provider calls and LLM inference.

## 5. Non-functional requirements
- Scale design: 1M registered users, 10K concurrent sessions. Actual capacity must be demonstrated by tests.
- Availability target: define initial SLO after hosting/provider selection; target 99.9% for core user-facing APIs as a planning goal, excluding declared maintenance and external provider outages.
- Performance targets (initial hypotheses): p95 read API <300 ms for ordinary indexed queries; p95 interactive write API <500 ms excluding long-running workflows; job submission <300 ms; async discovery completion measured separately by provider/source.
- Durable jobs: retries with exponential backoff and jitter, idempotency, dead-letter handling and replay.
- Security: TLS, encryption at rest, least privilege, tenant isolation, audit trails and secret management.
- Accessibility: WCAG 2.2 AA target for key workflows.
- Internationalization-ready; timezone-aware timestamps; Unicode support.
- Observability: logs, metrics, traces, queue age, provider errors and unit costs.
- Cost controls: per-tenant quotas, max pages per job, LLM budgets, provider budget and kill switches.

## 6. MVP boundary
Must include: identity/workspaces, ICP, company import, mockable source adapters, one permitted live discovery provider, public company-site crawl, evidence/provenance, candidate review, basic scoring, contact status, AI dossier behind feature flag, usage/audit, tests and deployment.
Defer: automated multichannel outreach, predictive revenue scoring, large-scale graph cluster, self-hosted LLM GPU fleet, complex billing, broad international registry coverage and autonomous agent tool execution.

## 7. Acceptance criteria
- Every company/person/contact/intent claim can be traced to one or more source evidence records or is explicitly marked as inference.
- Every provider call is rate-limited, metered, timeout-bounded and auditable.
- All tenant-owned queries are tenant-scoped and protected by automated isolation tests.
- Duplicate imports do not create duplicate canonical companies.
- A failed provider does not fail the entire pipeline; the job returns partial results and clear source status.
- AI output is schema-validated, cited and reviewable.
- Suppressed contacts cannot appear in outreach exports.
- User can inspect and correct a wrong identity match without losing source history.
- No unapproved automatic sending occurs.

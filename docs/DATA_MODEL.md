# Canonical Data Model

## Principles
- Store facts, claims and inferences separately.
- Keep provenance and timestamps at field/claim level where practical.
- Use stable internal IDs; do not use email or LinkedIn URL as a primary key.
- Preserve conflicting source claims for review rather than silently overwriting them.
- Every tenant-owned object is tenant-scoped.
- Store UTC timestamps and source timezone only when known.

## Core entities
### Tenant / User / Membership
`tenants(id, name, plan_id, status, created_at, updated_at)`
`users(id, identity_provider_id, email, status, created_at)`
`memberships(tenant_id, user_id, role, status, created_at)`
Unique `(tenant_id, user_id)`.

### Company
`companies(id, tenant_id nullable for global canonical entities, canonical_name, primary_domain, country_code, region, industry_code, employee_band, revenue_band nullable, description, lifecycle_status, created_at, updated_at)`
For shared global entities, define a separate global-company table and tenant-owned saved-account/workspace association. Do not mix global enrichment visibility with tenant-private notes.
`company_aliases(company_id, alias, source_evidence_id)`
`company_identifiers(company_id, identifier_type, identifier_value, jurisdiction, source_evidence_id)`

### Person and role history
`people(id, canonical_name, normalized_name, public_profile_url nullable, created_at, updated_at)`
`person_aliases(person_id, alias, source_evidence_id)`
`employment_roles(id, person_id, company_id, title, department, seniority, start_date nullable, end_date nullable, status, created_at)`
`person_company_links(id, person_id, company_id, relationship_status, confidence, evidence_set_id, valid_from, valid_to)`

### Contact points
`contact_points(id, person_id, type, value_encrypted_or_protected, normalized_value_hash, status, verification_method, verified_at, provider, source_evidence_id, last_seen_at, expires_at, created_at)`
Contact data access must be policy-controlled. Avoid storing personal emails unless a documented lawful basis and product purpose permit it. Suppression status overrides other statuses.

### Evidence and claims
`source_registry(id, provider_name, source_type, terms_reference, allowed_purposes, retention_policy, enabled, config_json)`
`evidence_records(id, tenant_id nullable, source_registry_id, source_url, fetched_at, published_at nullable, content_hash, content_type, storage_uri nullable, excerpt_redacted, license_metadata, retention_until, created_at)`
`claims(id, subject_type, subject_id, predicate, object_value_json, claim_type, status, confidence, observed_at, valid_from, valid_to, created_at)`
`claim_evidence(claim_id, evidence_record_id, support_type, excerpt_locator)`
`claim_type`: `source_fact`, `provider_fact`, `model_inference`, `user_assertion`.
`status`: `current`, `disputed`, `expired`, `retracted`.

### Intent signals
`intent_signals(id, company_id, signal_type, title, summary, observed_at, published_at nullable, expires_at nullable, confidence, relevance_score, status, created_at)`
`signal_evidence(signal_id, evidence_record_id)`
A signal is a hypothesis-generating clue, not proof of budget or purchase intent.

### Organization graph
`relationships(id, subject_type, subject_id, predicate, object_type, object_id, status, confidence, evidence_set_id, valid_from, valid_to, created_at, updated_at)`
Examples: `REPORTS_TO`, `INFLUENCES`, `DECIDES_FOR`, `WORKS_AT`, `USES_TECHNOLOGY`.
Only verified relationships may be displayed as facts. Inferences must be visibly labelled.

### ICP, scoring and workflow
`icp_profiles(id, tenant_id, name, definition_json, version, active, created_by, created_at)`
As-built Phase 5 (migration `0013_bd_workspace.sql`):
- `scoring_policies(id, tenant_id, version, weights jsonb, active, created_by, created_at)` — one active policy per tenant; weights must sum to 100.
- `score_runs(id, tenant_id, company_id, icp_profile_id, scoring_policy_id, scoring_version, total_score 0–100, eligible, suppression_override, factors jsonb, explanation, created_at)`
- `account_assignments` PK `(tenant_id, company_id)`; stages `identified|researching|qualified|outreach|meeting|closed_won|closed_lost|on_hold`
- `workspace_lists` + `list_items` (unique per list/entity)
- `tasks`, `notes`
- `export_batches` (scope `companies|list`, row_count, omitted_suppressed)
- `tenant_budgets` (nullable daily overrides; missing row falls back to env defaults)
- `workspace_controls` (per-workspace kill switches; global `FEATURE_*` env can still force off)
`activity_events` remains a conceptual timeline; audit uses `audit_events`.

### Jobs, usage and audit
`workflow_jobs(id, tenant_id, job_type, status, idempotency_key, input_json, result_json, cost_estimate, cost_actual, started_at, finished_at, error_code, error_summary, created_at)`
`provider_usage(id, tenant_id, provider, operation, request_count, units, estimated_cost, actual_cost nullable, status, occurred_at)`
`audit_events(id, tenant_id, actor, action, entity_type, entity_id, outcome, correlation_id, metadata_redacted, created_at)`
`consent_suppressions(id, tenant_id, contact_hash nullable, domain nullable, channel, reason, created_at, created_by)`

## Deduplication and entity resolution
- Company match signals: exact normalized domain, official registry ID, normalized name + country, aliases and manual review.
- Person match signals: normalized name, company association, title history and public profile reference. Avoid auto-merging on name alone.
- Store match candidates and match rationale; allow undo/merge review.
- Use deterministic rules first; model-based matching only proposes candidates with confidence and evidence.
- Never merge records across tenant-private data without an explicit shared-data policy.

## Indexing
- Unique index on normalized primary domain where appropriate.
- Composite indexes `(tenant_id, created_at)`, `(tenant_id, status)`, `(tenant_id, company_id)`.
- GIN indexes only for JSONB fields with demonstrated query patterns.
- Full-text search initially in PostgreSQL; external search index is derived and rebuildable.
- Avoid premature partitioning; benchmark with realistic data volumes.

## Retention and deletion
- Retention policies by source type and contract.
- Expired evidence may retain hash/metadata where lawful while deleting raw content.
- Deletion must propagate to derived graph/search/cache/export copies.
- Keep minimal suppression hashes where legally permitted to prevent re-importing suppressed contacts.

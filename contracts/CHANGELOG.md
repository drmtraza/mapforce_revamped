# Contract changelog

## 2026-10-11 (Phase 2)
- **`adapter-result.v1.schema.json` — additive, non-breaking.**
  - `operation` enum adds `discover_companies`.
  - New optional `companies` array of discovery candidates `{ref, name, domain, country_code, description, claim_type, confidence, evidence_refs}`; `claim_type` is limited to `source_fact`/`provider_fact`, `domain` must be a lowercase bare hostname, and every candidate must cite evidence in the same payload.
  - The control-plane validator also rejects duplicate candidate domains and `companies` on any other operation.
  - Existing v1 payloads (without `companies`) remain valid; `schema_version` stays `1`.
- **`openapi.v1.json`** — additive endpoints for sources, imports, discovery and dead letters (see `docs/PHASE_2_REPORT.md`). No existing response shape is removed or narrowed.

## 2026-10-11
- **Added `org-map.v2.schema.json`** (breaking vs v1; approved by owner, decision D8).
  - `schema_version: 2` required.
  - Relationships require `rationale` and `claim_type`; `evidence_ids` must be non-empty.
  - Relationship `status` adds `expired`; a `model_inference` relationship may only be `inferred` or `disputed`.
  - `outreach_angle` is either `null` or an object `{value, claim_type: "model_inference", confidence, evidence_ids, rationale}`.
  - Optional `display_name`, `review_status`, `relationship_id` for UI rendering.
  - v1 (`org-map.schema.json`) is retained unchanged for reference.
- **Added `adapter-result.v1.schema.json`**: normalized provider adapter output validated by the control plane before any canonical write.
- **Added `event-envelope.v1.schema.json`**: outbox event envelope per `docs/API_AND_EVENT_CONTRACTS.md`.
- `lead.schema.json` unchanged.

# Contract changelog

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

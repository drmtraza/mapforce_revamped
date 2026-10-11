# API and Event Contracts

## API conventions
- Base path `/api/v1`.
- JSON request/response; OpenAPI document generated in CI.
- Authentication via secure session/OIDC integration; do not place long-lived bearer tokens in browser storage if avoidable.
- All tenant-owned routes derive tenant access from authenticated membership. Never trust a client-supplied `tenant_id` without authorization.
- Cursor pagination for large lists; include `next_cursor`, `has_more`.
- Standard error shape:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be processed.",
    "correlation_id": "opaque-id",
    "details": []
  }
}
```
- Idempotent mutations accept `Idempotency-Key` and persist outcome for a defined TTL.
- Rate limit by user, tenant, endpoint and provider budget.

## Initial endpoint surface
### Workspaces
- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/{workspaceId}/members`
- `POST /workspaces/{workspaceId}/invitations`

### ICP and target lists
- `GET /icp-profiles`
- `POST /icp-profiles`
- `PATCH /icp-profiles/{id}`
- `POST /imports/companies` (supports dry-run)
- `GET /imports/{id}`

### Companies and evidence
- `GET /companies?query=&industry=&country=&scoreMin=&cursor=`
- `POST /companies` (manual create)
- `GET /companies/{id}`
- `GET /companies/{id}/dossier`
- `GET /companies/{id}/evidence`
- `POST /companies/{id}/research-jobs`
- `GET /research-jobs/{jobId}`
- `POST /research-jobs/{jobId}/cancel`

### People and organization map
- `GET /companies/{id}/people`
- `GET /people/{id}`
- `GET /companies/{id}/org-map`
- `POST /companies/{id}/org-map-jobs`
- `GET /org-map-jobs/{id}`
- `GET /companies/{id}/outreach-drafts`
- `POST /people/{id}/review` (confirm, reject, mark disputed)
- `POST /relationships/{id}/review`

### Signals and scoring
- `GET /companies/{id}/signals`
- `GET /scoring-policies`
- `POST /scoring-policies`
- `POST /icp-profiles/{id}/score-runs`
- `GET /score-runs/{id}`
- `GET /companies/{id}/score`

### BD workflow
- `GET /accounts`
- `PATCH /accounts/{companyId}`
- `GET/POST /lists`, `GET /lists/{id}`, `POST /lists/{id}/items`, `DELETE /lists/{id}/items/{itemId}`
- `GET /companies/{id}/tasks`, `POST /tasks`, `PATCH /tasks/{id}`
- `GET /companies/{id}/notes`, `POST /notes`
- `PATCH /outreach-drafts/{id}` (approve or reject; never sent)
- `POST /exports` (suppression applied; formula-injection-safe CSV; contact values omitted)
- `GET /usage`
- `GET/PATCH /workspace-budget`
- `GET /ops/status`, `GET/PATCH /workspace-controls`
- `GET /ops/retention`, `POST /ops/retention-sweep` (redacts expired excerpts only)
- `GET /metrics` (process scrape; no tenant labels; hide behind ingress)
- `GET /audit-events`

## Async job contract
`POST /companies/{id}/research-jobs` returns `202 Accepted`:
```json
{
  "job_id": "job_opaque",
  "status": "queued",
  "status_url": "/api/v1/research-jobs/job_opaque"
}
```
Status values: `queued`, `running`, `partial_success`, `succeeded`, `failed`, `cancel_requested`, `cancelled`.
A job may succeed partially. Per-source outcomes must be available to the user.

## Event envelope
```json
{
  "event_id": "uuid",
  "event_type": "research.company.requested",
  "schema_version": 1,
  "occurred_at": "2026-01-01T00:00:00Z",
  "tenant_id": "tenant-id",
  "correlation_id": "trace-id",
  "causation_id": "optional-event-id",
  "idempotency_key": "stable-key",
  "payload": {}
}
```
Event types:
- `research.company.requested`
- `discovery.source.completed`
- `crawl.evidence.created`
- `company.normalized`
- `person.candidate.discovered`
- `contact.enrichment.requested`
- `contact.enrichment.completed`
- `signal.detected`
- `orgmap.inference.requested`
- `orgmap.inference.completed`
- `score.calculated`
- `research.job.completed`
- `suppression.created`
- `evidence.retention.expired`

## Reliability requirements
- Use transactional outbox for event publication.
- Consumers must be idempotent using event ID and/or business idempotency key.
- Events contain references/IDs, not large raw page bodies or unnecessary contact PII.
- Include retry count and source/provider metadata in job records, not as unbounded event payload.
- Dead-letter failures are observable and replayable by authorized operators.
- Schema changes are additive and versioned; consumers tolerate unknown optional fields.

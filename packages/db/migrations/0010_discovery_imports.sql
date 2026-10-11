-- Phase 2: source policy, per-workspace source settings, company discovery, CSV imports,
-- and tenant-scoped dead-letter replay.

-- Source registry v2. `enabled` stays the global kill switch (owner-managed, never via the API).
ALTER TABLE source_registry
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN operations text[] NOT NULL DEFAULT '{}',
  ADD COLUMN requires_credentials boolean NOT NULL DEFAULT false,
  ADD COLUMN default_tenant_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN freshness_ttl_hours integer NOT NULL DEFAULT 720
    CHECK (freshness_ttl_hours BETWEEN 1 AND 87600),
  ADD COLUMN retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  ADD COLUMN max_requests_per_job integer NOT NULL DEFAULT 10
    CHECK (max_requests_per_job BETWEEN 1 AND 1000);

UPDATE source_registry SET
  operations = ARRAY['fetch_company_evidence'],
  description = 'Deterministic synthetic company website pages.'
WHERE id = 'mock_web';
UPDATE source_registry SET
  operations = ARRAY['discover_people'],
  description = 'Deterministic synthetic people directory.'
WHERE id = 'mock_people';
UPDATE source_registry SET
  operations = ARRAY['fetch_registry_record'],
  description = 'Deterministic synthetic company registry; fails for domains containing "outage".'
WHERE id = 'mock_registry';

INSERT INTO source_registry (
  id, provider_name, source_type, terms_reference, allowed_purposes, retention_policy,
  enabled, is_mock, description, operations, requires_credentials, default_tenant_enabled,
  freshness_ttl_hours, retention_days, max_requests_per_job
) VALUES
  ('company_site', 'Public company website', 'company_website',
   'Public pages only; robots.txt honoured on every request; identified user agent; per-domain delay and page budget.',
   ARRAY['b2b_research'], 'retain_90_days', true, false,
   'Crawls a bounded set of public pages on the company''s own domain.',
   ARRAY['fetch_company_evidence'], false, false, 168, 90, 8),
  ('brave_search', 'Brave Search API', 'search_api',
   'https://api-dashboard.search.brave.com/terms-of-service (owner review required before enabling).',
   ARRAY['b2b_research'], 'retain_30_days', false, false,
   'Web search used to discover candidate companies. Requires an API key on the research worker.',
   ARRAY['discover_companies'], true, false, 168, 30, 3),
  ('mock_search', 'Mock company search', 'search_api', 'synthetic-fixture',
   ARRAY['development', 'testing'], 'retain_90_days', true, true,
   'Deterministic synthetic company search results.',
   ARRAY['discover_companies'], false, true, 168, 90, 1);

CREATE TABLE tenant_source_settings (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source_key  text NOT NULL REFERENCES source_registry (id),
  enabled     boolean NOT NULL,
  updated_by  uuid NOT NULL REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_key)
);
GRANT SELECT, INSERT, UPDATE ON tenant_source_settings TO app_rw;
ALTER TABLE tenant_source_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_source_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_source_settings_tenant ON tenant_source_settings FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Discovery jobs share the job lifecycle with research but have no company yet.
ALTER TABLE workflow_jobs ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_job_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_job_type_check
  CHECK (job_type IN ('company_research', 'company_discovery'));
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_research_has_company
  CHECK (job_type <> 'company_research' OR company_id IS NOT NULL);
ALTER TABLE workflow_jobs ADD COLUMN query jsonb;

CREATE TABLE discovery_candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES workflow_jobs (id) ON DELETE CASCADE,
  source_key          text NOT NULL REFERENCES source_registry (id),
  domain              text NOT NULL CHECK (domain = lower(domain)),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  country_code        text CHECK (country_code ~ '^[A-Z]{2}$'),
  description         text CHECK (length(description) <= 1000),
  claim_type          text NOT NULL CHECK (claim_type IN ('source_fact', 'provider_fact')),
  confidence          numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_record_id  uuid NOT NULL REFERENCES evidence_records (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed')),
  company_id          uuid REFERENCES companies (id) ON DELETE SET NULL,
  decided_by          uuid REFERENCES users (id),
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id, domain)
);
CREATE INDEX discovery_candidates_job_idx ON discovery_candidates (tenant_id, job_id, created_at);
GRANT SELECT, INSERT, UPDATE ON discovery_candidates TO app_rw;
ALTER TABLE discovery_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_candidates_tenant ON discovery_candidates FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- CSV imports. Dry runs are not persisted; committed imports keep a per-row outcome.
CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('companies')),
  idempotency_key  text NOT NULL,
  filename         text CHECK (length(filename) <= 255),
  content_hash     text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  row_count        integer NOT NULL CHECK (row_count >= 0),
  created_count    integer NOT NULL DEFAULT 0,
  existing_count   integer NOT NULL DEFAULT 0,
  duplicate_count  integer NOT NULL DEFAULT 0,
  invalid_count    integer NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE INDEX import_batches_tenant_created_idx ON import_batches (tenant_id, created_at DESC, id DESC);

CREATE TABLE import_rows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  batch_id           uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  row_number         integer NOT NULL CHECK (row_number >= 1),
  raw                jsonb NOT NULL,
  normalized_domain  text,
  outcome            text NOT NULL
                     CHECK (outcome IN ('created', 'existing', 'duplicate_in_file', 'invalid')),
  error_code         text,
  error_message      text,
  company_id         uuid REFERENCES companies (id) ON DELETE SET NULL,
  UNIQUE (batch_id, row_number)
);
CREATE INDEX import_rows_batch_idx ON import_rows (tenant_id, batch_id, row_number);

GRANT SELECT, INSERT ON import_batches, import_rows TO app_rw;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_tenant ON import_batches FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_rows_tenant ON import_rows FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Workspace admins may inspect and replay their own dead-lettered events (RLS still applies).
GRANT UPDATE (attempts, next_attempt_at, dead_lettered_at, last_error) ON outbox_events TO app_rw;
CREATE INDEX outbox_dead_letter_idx ON outbox_events (tenant_id, dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

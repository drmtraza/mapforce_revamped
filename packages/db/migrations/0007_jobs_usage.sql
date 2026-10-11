-- Research workflow jobs, per-source outcomes and provider usage metering.
CREATE TABLE workflow_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  job_type              text NOT NULL CHECK (job_type IN ('company_research')),
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'partial_success', 'succeeded', 'failed',
                                          'cancel_requested', 'cancelled')),
  idempotency_key       text NOT NULL,
  input                 jsonb NOT NULL,
  result                jsonb,
  requested_by          uuid NOT NULL REFERENCES users (id),
  temporal_workflow_id  text NOT NULL,
  cost_estimate         numeric(14, 6),
  cost_actual           numeric(14, 6),
  started_at            timestamptz,
  finished_at           timestamptz,
  error_code            text,
  error_summary         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, job_type, idempotency_key)
);
-- At most one active research job per company; concurrent submits converge on it.
CREATE UNIQUE INDEX workflow_jobs_one_active_idx ON workflow_jobs (tenant_id, company_id, job_type)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX workflow_jobs_tenant_company_idx ON workflow_jobs (tenant_id, company_id, created_at DESC);
CREATE INDEX workflow_jobs_tenant_status_idx ON workflow_jobs (tenant_id, status);
CREATE INDEX workflow_jobs_tenant_created_idx ON workflow_jobs (tenant_id, created_at);
CREATE TRIGGER workflow_jobs_updated_at BEFORE UPDATE ON workflow_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workflow_job_sources (
  job_id          uuid NOT NULL REFERENCES workflow_jobs (id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source_key      text NOT NULL REFERENCES source_registry (id),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  evidence_count  integer NOT NULL DEFAULT 0,
  error_code      text,
  error_summary   text,
  started_at      timestamptz,
  finished_at     timestamptz,
  PRIMARY KEY (job_id, source_key)
);

CREATE TABLE provider_usage (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  workflow_job_id  uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  provider         text NOT NULL,
  source_key       text NOT NULL REFERENCES source_registry (id),
  operation        text NOT NULL,
  request_count    integer NOT NULL CHECK (request_count >= 0),
  units            numeric(14, 4) NOT NULL DEFAULT 0,
  unit_type        text NOT NULL,
  estimated_cost   numeric(14, 6),
  actual_cost      numeric(14, 6),
  status           text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workflow_job_id, source_key, operation)
);
CREATE INDEX provider_usage_tenant_time_idx ON provider_usage (tenant_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON workflow_jobs, workflow_job_sources, provider_usage TO app_rw;

ALTER TABLE workflow_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_jobs_tenant ON workflow_jobs FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE workflow_job_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_job_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_job_sources_tenant ON workflow_job_sources FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_usage_tenant ON provider_usage FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

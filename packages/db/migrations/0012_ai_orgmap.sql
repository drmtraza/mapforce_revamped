-- Phase 4: AI organization mapping runs, quarantine and human-reviewed outreach drafts.
-- As-built numbering: 0011 is people/contacts/signals; this file is 0012.

ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_job_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_job_type_check
  CHECK (job_type IN ('company_research', 'company_discovery', 'person_enrichment', 'company_orgmap'));
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_orgmap_has_company
  CHECK (job_type <> 'company_orgmap' OR company_id IS NOT NULL);

CREATE TABLE ai_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  workflow_job_id     uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  provider            text NOT NULL CHECK (provider IN ('mock', 'hermes', 'fallback')),
  prompt_version      text NOT NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('succeeded', 'quarantined', 'failed')),
  validation_outcome  text NOT NULL CHECK (validation_outcome IN ('accepted', 'rejected', 'fallback')),
  token_count         integer NOT NULL DEFAULT 0 CHECK (token_count BETWEEN 0 AND 1000000),
  duration_ms         integer NOT NULL DEFAULT 0 CHECK (duration_ms BETWEEN 0 AND 600000),
  evidence_ids        text[] NOT NULL DEFAULT '{}',
  result              jsonb,
  error_code          text,
  error_summary       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_runs_company_idx ON ai_runs (tenant_id, company_id, created_at DESC);

CREATE TABLE ai_quarantine (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ai_run_id       uuid NOT NULL REFERENCES ai_runs (id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  raw_excerpt     text NOT NULL CHECK (length(raw_excerpt) <= 4000),
  errors          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_quarantine_run_idx ON ai_quarantine (tenant_id, ai_run_id);

CREATE TABLE outreach_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  ai_run_id       uuid REFERENCES ai_runs (id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  claim_type      text NOT NULL CHECK (claim_type = 'model_inference'),
  confidence      numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_ids    text[] NOT NULL CHECK (cardinality(evidence_ids) >= 1),
  rationale       text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outreach_drafts_company_idx ON outreach_drafts (tenant_id, company_id, created_at DESC);
CREATE INDEX outreach_drafts_person_idx ON outreach_drafts (tenant_id, person_id);

GRANT SELECT, INSERT, UPDATE ON ai_runs, ai_quarantine, outreach_drafts TO app_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_runs', 'ai_quarantine', 'outreach_drafts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_rw USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant())',
      t || '_tenant', t);
  END LOOP;
END
$$;

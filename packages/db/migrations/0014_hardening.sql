-- Phase 6: query indexes for usage/export/pipeline, workspace kill switches, FORCE RLS.

CREATE INDEX IF NOT EXISTS export_batches_tenant_created_idx
  ON export_batches (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_jobs_tenant_type_created_idx
  ON workflow_jobs (tenant_id, job_type, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_jobs_tenant_active_idx
  ON workflow_jobs (tenant_id, status)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX IF NOT EXISTS ai_runs_tenant_created_idx
  ON ai_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_assignments_tenant_stage_idx
  ON account_assignments (tenant_id, stage);
CREATE INDEX IF NOT EXISTS evidence_retention_idx
  ON evidence_records (tenant_id, retention_until)
  WHERE retention_until IS NOT NULL;

CREATE TABLE workspace_controls (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  research_enabled    boolean NOT NULL DEFAULT true,
  discovery_enabled   boolean NOT NULL DEFAULT true,
  enrich_enabled      boolean NOT NULL DEFAULT true,
  ai_enabled          boolean NOT NULL DEFAULT true,
  export_enabled      boolean NOT NULL DEFAULT true,
  updated_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER workspace_controls_updated_at BEFORE UPDATE ON workspace_controls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_controls TO app_rw;

ALTER TABLE workspace_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_controls_tenant ON workspace_controls
  FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

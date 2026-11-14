-- Phase 14: account intelligence reports (agentic research assembly).
-- Reports are draft-for-review only — never auto-written to CRM.

CREATE TABLE account_intelligence_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'draft_for_review'
                      CHECK (status IN ('draft_for_review', 'accepted', 'dismissed', 'quarantined')),
  orchestrator_version text NOT NULL DEFAULT 'account-intel/1.0.0',
  provider            text NOT NULL CHECK (provider IN ('mock', 'hermes', 'fallback', 'deterministic')),
  summary             text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  sections            jsonb NOT NULL,
  quarantined_claims  jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_trace         jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_count         integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  duration_ms         integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  review_note         text CHECK (review_note IS NULL OR length(review_note) <= 2000),
  created_by          uuid NOT NULL REFERENCES users (id),
  reviewed_by         uuid REFERENCES users (id),
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_intelligence_reports_company_idx
  ON account_intelligence_reports (tenant_id, company_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON account_intelligence_reports TO app_rw;

CREATE TRIGGER account_intelligence_reports_updated_at BEFORE UPDATE ON account_intelligence_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  ALTER TABLE account_intelligence_reports ENABLE ROW LEVEL SECURITY;
  ALTER TABLE account_intelligence_reports FORCE ROW LEVEL SECURITY;
  CREATE POLICY account_intelligence_reports_tenant ON account_intelligence_reports
    FOR ALL TO app_rw
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());
END
$$;

INSERT INTO feature_flags (key, description, enabled) VALUES
  ('account_intelligence', 'Enable one-click account intelligence report generation', true)
ON CONFLICT (key) DO NOTHING;

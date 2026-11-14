-- Phase 15: buying committee classifications + versioned account plans.
-- No invented reporting lines. budget_owner requires evidence.

ALTER TABLE account_assignments
  ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE buying_committee_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  committee_role      text NOT NULL CHECK (committee_role IN (
                        'economic_buyer', 'champion', 'technical_evaluator',
                        'procurement', 'legal', 'end_user', 'blocker', 'coach',
                        'budget_owner', 'influencer', 'unknown'
                      )),
  claim_type          text NOT NULL
                      CHECK (claim_type IN (
                        'source_fact', 'provider_fact', 'model_inference', 'user_assertion'
                      )),
  confidence          numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale           text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  -- Evidence IDs required when claim_type is source/provider OR role is budget_owner.
  evidence_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'dismissed')),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, person_id, committee_role),
  CHECK (
    committee_role <> 'budget_owner'
    OR jsonb_array_length(evidence_ids) > 0
  ),
  CHECK (
    claim_type NOT IN ('source_fact', 'provider_fact')
    OR jsonb_array_length(evidence_ids) > 0
  )
);
CREATE INDEX buying_committee_company_idx
  ON buying_committee_members (tenant_id, company_id, status, committee_role);

CREATE TABLE account_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'archived')),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  situation           text NOT NULL CHECK (length(situation) BETWEEN 1 AND 4000),
  objective           text NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
  strategy            text NOT NULL CHECK (length(strategy) BETWEEN 1 AND 4000),
  risks               text NOT NULL DEFAULT '' CHECK (length(risks) <= 4000),
  next_steps          text NOT NULL CHECK (length(next_steps) BETWEEN 1 AND 4000),
  coverage_score      integer NOT NULL DEFAULT 0 CHECK (coverage_score BETWEEN 0 AND 100),
  coverage_note       text NOT NULL DEFAULT '' CHECK (length(coverage_note) <= 1000),
  -- Explicit note: plans never invent reporting lines.
  reporting_note      text NOT NULL DEFAULT 'Reporting lines are only shown when sourced relationships exist; this plan does not invent them.'
                      CHECK (length(reporting_note) BETWEEN 1 AND 500),
  assigned_manager_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, version)
);
CREATE INDEX account_plans_company_idx
  ON account_plans (tenant_id, company_id, status, version DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON buying_committee_members, account_plans TO app_rw;

CREATE TRIGGER buying_committee_members_updated_at BEFORE UPDATE ON buying_committee_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER account_plans_updated_at BEFORE UPDATE ON account_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['buying_committee_members', 'account_plans']
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

INSERT INTO feature_flags (key, description, enabled) VALUES
  ('buying_committee', 'Enable buying committee classifications and coverage score', true),
  ('account_plans', 'Enable versioned account plans with manager assign', true)
ON CONFLICT (key) DO NOTHING;

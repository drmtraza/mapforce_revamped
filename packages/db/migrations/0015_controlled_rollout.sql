-- Phase 7: beta plans, feature flags, provider cost ceilings, feedback, synthetic checks, triage.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS rollout_notes text CHECK (rollout_notes IS NULL OR length(rollout_notes) <= 2000);

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_plan_id_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_id_check
  CHECK (plan_id IN ('development', 'beta', 'ga'));

UPDATE tenants SET plan_id = 'development' WHERE plan_id NOT IN ('development', 'beta', 'ga');

ALTER TABLE tenant_budgets
  ADD COLUMN IF NOT EXISTS daily_provider_cost_ceiling numeric(12, 4)
    CHECK (daily_provider_cost_ceiling IS NULL OR daily_provider_cost_ceiling >= 0);

CREATE TABLE feature_flags (
  key           text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  enabled       boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON feature_flags TO app_rw;

INSERT INTO feature_flags (key, description, enabled) VALUES
  ('live_search', 'Permit Brave Search when credentials and source registry allow it', false),
  ('licensed_contacts', 'Permit licensed contact enrichment when D12 is approved', false),
  ('hermes', 'Permit Hermes model calls when FEATURE_HERMES and URL are set', false),
  ('bulk_export', 'Permit larger export batches for GA plans', false),
  ('beta_feedback', 'Show in-product feedback form for beta workspaces', true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE tenant_feature_overrides (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  flag_key      text NOT NULL REFERENCES feature_flags (key) ON DELETE CASCADE,
  enabled       boolean NOT NULL,
  updated_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, flag_key)
);
CREATE INDEX tenant_feature_overrides_tenant_idx ON tenant_feature_overrides (tenant_id);

CREATE TABLE feedback_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users (id),
  category      text NOT NULL CHECK (category IN ('bug', 'data_quality', 'ux', 'request', 'other')),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_items_tenant_idx ON feedback_items (tenant_id, created_at DESC);

CREATE TABLE synthetic_check_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants (id) ON DELETE SET NULL,
  check_name    text NOT NULL CHECK (length(check_name) BETWEEN 1 AND 80),
  ok            boolean NOT NULL,
  latency_ms    integer NOT NULL CHECK (latency_ms >= 0),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX synthetic_check_runs_created_idx ON synthetic_check_runs (created_at DESC);

CREATE TABLE quota_ramp_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users (id),
  field         text NOT NULL,
  previous_value integer,
  next_value    integer NOT NULL,
  plan_ceiling  integer NOT NULL,
  rationale     text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_ramp_events_tenant_idx ON quota_ramp_events (tenant_id, created_at DESC);

CREATE TABLE incident_triage_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users (id),
  severity      text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigating', 'resolved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_triage_notes_tenant_idx ON incident_triage_notes (tenant_id, created_at DESC);
CREATE TRIGGER incident_triage_notes_updated_at BEFORE UPDATE ON incident_triage_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_feature_overrides, feedback_items,
  quota_ramp_events, incident_triage_notes TO app_rw;
GRANT SELECT, INSERT ON synthetic_check_runs TO app_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_feature_overrides', 'feedback_items', 'quota_ramp_events', 'incident_triage_notes'
  ]
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

-- Synthetic runs may be platform-wide (tenant_id null) or tenant-scoped.
ALTER TABLE synthetic_check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthetic_check_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY synthetic_check_runs_read ON synthetic_check_runs FOR SELECT TO app_rw
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY synthetic_check_runs_insert ON synthetic_check_runs FOR INSERT TO app_rw
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant());

-- Cross-tenant plan seat counts for limited beta rollout (no row data returned).
CREATE OR REPLACE FUNCTION count_tenants_on_plan(p_plan text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM tenants WHERE plan_id = p_plan;
$$;
REVOKE ALL ON FUNCTION count_tenants_on_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_tenants_on_plan(text) TO app_rw;

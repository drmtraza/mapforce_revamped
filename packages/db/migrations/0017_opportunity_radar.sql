-- Phase 13: Market Opportunity Radar + mission MVP.
-- Freshness decay and dedupe live on market_opportunities.
-- Missions are schedule/budget configs; Temporal Schedule wiring is additive later.

ALTER TABLE intent_signals DROP CONSTRAINT IF EXISTS intent_signals_signal_type_check;
ALTER TABLE intent_signals ADD CONSTRAINT intent_signals_signal_type_check
  CHECK (signal_type IN (
    'hiring', 'funding', 'procurement', 'news', 'product', 'other',
    'tender', 'leadership_change', 'expansion', 'partnership'
  ));

CREATE TABLE market_opportunities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  opportunity_kind    text NOT NULL CHECK (opportunity_kind IN (
                        'signal', 'product_match', 'announcement'
                      )),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  summary             text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  claim_type          text NOT NULL
                      CHECK (claim_type IN (
                        'source_fact', 'provider_fact', 'model_inference', 'user_assertion'
                      )),
  confidence          numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  freshness_score     integer NOT NULL CHECK (freshness_score BETWEEN 0 AND 100),
  observed_at         timestamptz NOT NULL,
  fingerprint         text NOT NULL CHECK (length(fingerprint) BETWEEN 16 AND 128),
  source_signal_id    uuid REFERENCES intent_signals (id) ON DELETE SET NULL,
  source_match_result_id uuid REFERENCES opportunity_match_results (id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'dismissed', 'snoozed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fingerprint)
);
CREATE INDEX market_opportunities_feed_idx
  ON market_opportunities (tenant_id, status, freshness_score DESC, observed_at DESC);
CREATE INDEX market_opportunities_company_idx
  ON market_opportunities (tenant_id, company_id, observed_at DESC);

CREATE TABLE radar_missions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused')),
  interval_hours      integer NOT NULL DEFAULT 24
                      CHECK (interval_hours BETWEEN 1 AND 168),
  daily_run_budget    integer NOT NULL DEFAULT 4
                      CHECK (daily_run_budget BETWEEN 1 AND 48),
  runs_today          integer NOT NULL DEFAULT 0 CHECK (runs_today >= 0),
  runs_today_on       date NOT NULL DEFAULT (CURRENT_DATE),
  last_run_at         timestamptz,
  next_run_at         timestamptz,
  target_countries    jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_industries   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Temporal Schedule id reserved for later worker registration; null until wired.
  temporal_schedule_id text CHECK (temporal_schedule_id IS NULL OR length(temporal_schedule_id) <= 200),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_missions_tenant_idx ON radar_missions (tenant_id, status, next_run_at NULLS LAST);

CREATE TABLE radar_mission_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  mission_id          uuid NOT NULL REFERENCES radar_missions (id) ON DELETE CASCADE,
  status              text NOT NULL CHECK (status IN ('succeeded', 'skipped_budget', 'skipped_paused', 'failed')),
  opportunities_upserted integer NOT NULL DEFAULT 0 CHECK (opportunities_upserted >= 0),
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_mission_runs_mission_idx
  ON radar_mission_runs (tenant_id, mission_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON market_opportunities, radar_missions, radar_mission_runs TO app_rw;

CREATE TRIGGER market_opportunities_updated_at BEFORE UPDATE ON market_opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER radar_missions_updated_at BEFORE UPDATE ON radar_missions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['market_opportunities', 'radar_missions', 'radar_mission_runs']
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
  ('opportunity_radar', 'Enable Market Opportunity Radar feed APIs and UI', true),
  ('radar_missions', 'Enable radar mission configs (pause/resume/budget)', true)
ON CONFLICT (key) DO NOTHING;

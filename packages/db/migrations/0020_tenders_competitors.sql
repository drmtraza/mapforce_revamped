-- Phase 16: tenders + competitor watchlists/battlecards.
-- No auto-submit of bids. No fabricated certifications.

CREATE TABLE tenders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid REFERENCES companies (id) ON DELETE SET NULL,
  external_ref        text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  summary             text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  buyer_name          text NOT NULL CHECK (length(buyer_name) BETWEEN 1 AND 200),
  country_code        text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  category            text NOT NULL DEFAULT 'other'
                      CHECK (category IN (
                        'cybersecurity', 'cloud', 'software', 'professional_services',
                        'infrastructure', 'other'
                      )),
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'closed', 'awarded', 'cancelled', 'watching')),
  published_at        timestamptz,
  closes_at           timestamptz,
  source_key          text NOT NULL REFERENCES source_registry (id),
  source_url          text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2000),
  claim_type          text NOT NULL DEFAULT 'provider_fact'
                      CHECK (claim_type IN (
                        'source_fact', 'provider_fact', 'model_inference', 'user_assertion'
                      )),
  evidence_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_key, external_ref)
);
CREATE INDEX tenders_tenant_idx ON tenders (tenant_id, status, closes_at NULLS LAST);

CREATE TABLE tender_bid_assessments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  tender_id           uuid NOT NULL REFERENCES tenders (id) ON DELETE CASCADE,
  recommendation      text NOT NULL CHECK (recommendation IN ('bid', 'no_bid', 'review')),
  fit_score           integer NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  factors             jsonb NOT NULL,
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb,
  note                text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  -- Human decision only; system never auto-submits.
  human_decision      text CHECK (human_decision IS NULL OR human_decision IN (
                        'bid', 'no_bid', 'defer'
                      )),
  decided_by          uuid REFERENCES users (id),
  decided_at          timestamptz,
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tender_bid_assessments_tender_idx
  ON tender_bid_assessments (tenant_id, tender_id, created_at DESC);

CREATE TABLE competitors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  domain              text CHECK (domain IS NULL OR length(domain) BETWEEN 1 AND 253),
  notes               text CHECK (notes IS NULL OR length(notes) <= 2000),
  status              text NOT NULL DEFAULT 'watching'
                      CHECK (status IN ('watching', 'archived')),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX competitors_tenant_name_idx ON competitors (tenant_id, lower(name));
CREATE INDEX competitors_tenant_idx ON competitors (tenant_id, status, created_at DESC);

CREATE TABLE competitor_battlecards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  competitor_id       uuid NOT NULL REFERENCES competitors (id) ON DELETE CASCADE,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  strengths           text NOT NULL CHECK (length(strengths) BETWEEN 1 AND 4000),
  weaknesses          text NOT NULL CHECK (length(weaknesses) BETWEEN 1 AND 4000),
  landmines           text NOT NULL DEFAULT '' CHECK (length(landmines) <= 4000),
  our_differentiators text NOT NULL CHECK (length(our_differentiators) BETWEEN 1 AND 4000),
  -- Certifications only when evidenced; never fabricate.
  certifications_note text NOT NULL DEFAULT 'No certifications asserted without evidence.'
                      CHECK (length(certifications_note) BETWEEN 1 AND 1000),
  evidence_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  claim_type          text NOT NULL DEFAULT 'user_assertion'
                      CHECK (claim_type IN (
                        'source_fact', 'provider_fact', 'model_inference', 'user_assertion'
                      )),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, competitor_id, version),
  CHECK (
    claim_type NOT IN ('source_fact', 'provider_fact')
    OR jsonb_array_length(evidence_ids) > 0
  )
);
CREATE INDEX competitor_battlecards_competitor_idx
  ON competitor_battlecards (tenant_id, competitor_id, version DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenders, tender_bid_assessments,
  competitors, competitor_battlecards TO app_rw;

CREATE TRIGGER tenders_updated_at BEFORE UPDATE ON tenders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER competitors_updated_at BEFORE UPDATE ON competitors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenders', 'tender_bid_assessments', 'competitors', 'competitor_battlecards'
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

INSERT INTO source_registry (
  id, provider_name, source_type, terms_reference, allowed_purposes, retention_policy,
  enabled, is_mock, description, operations, requires_credentials, default_tenant_enabled,
  freshness_ttl_hours, retention_days, max_requests_per_job
) VALUES (
  'mock_tenders', 'Mock public tenders', 'procurement', 'synthetic-fixture',
  ARRAY['development', 'testing'], 'retain_90_days', true, true,
  'Deterministic synthetic tender notices. Never auto-submits bids.',
  ARRAY['fetch_intent_signals'], false, true, 168, 90, 5
) ON CONFLICT (id) DO NOTHING;

INSERT INTO feature_flags (key, description, enabled) VALUES
  ('tenders', 'Enable tender intake, mock sync, and bid/no-bid assist', true),
  ('competitors', 'Enable competitor watchlists and battlecards', true)
ON CONFLICT (key) DO NOTHING;

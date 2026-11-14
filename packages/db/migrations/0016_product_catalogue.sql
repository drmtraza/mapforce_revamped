-- Phase 12: product/services catalogue and company→offering opportunity matching.
-- Match scores are separate from ICP account scoring (icp-explainable/1.0.0).

CREATE TABLE product_offerings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  category          text NOT NULL CHECK (category IN (
                      'product', 'software', 'saas', 'cloud', 'cybersecurity',
                      'ai_automation', 'professional_services', 'consulting',
                      'training', 'distribution', 'custom_enterprise', 'other'
                    )),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  business_problem  text NOT NULL CHECK (length(business_problem) BETWEEN 1 AND 2000),
  target_industries jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_countries  jsonb NOT NULL DEFAULT '[]'::jsonb,
  employee_bands    jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_personas   jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_model     text NOT NULL DEFAULT 'unspecified'
                    CHECK (pricing_model IN (
                      'unspecified', 'subscription', 'one_time', 'usage',
                      'fixed_fee', 'time_materials', 'reseller'
                    )),
  -- Human-authored indicative range only; AI must not invent prices.
  price_range_note  text CHECK (price_range_note IS NULL OR length(price_range_note) <= 500),
  requirements_note text CHECK (requirements_note IS NULL OR length(requirements_note) <= 2000),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft', 'active', 'archived')),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by        uuid NOT NULL REFERENCES users (id),
  updated_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_offerings_tenant_idx ON product_offerings (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX product_offerings_name_version_idx
  ON product_offerings (tenant_id, lower(name), version);

CREATE TABLE product_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  offering_id       uuid NOT NULL REFERENCES product_offerings (id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  doc_kind          text NOT NULL CHECK (doc_kind IN (
                      'brochure', 'case_study', 'spec', 'pricing', 'certification', 'other'
                    )),
  -- Workspace-approved URI or evidence key reference; not scraped content.
  source_uri        text NOT NULL CHECK (length(source_uri) BETWEEN 1 AND 2000),
  notes             text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_documents_offering_idx ON product_documents (tenant_id, offering_id, created_at DESC);

CREATE TABLE opportunity_match_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  matching_version  text NOT NULL DEFAULT 'product-match/1.0.0',
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_match_runs_company_idx
  ON opportunity_match_runs (tenant_id, company_id, created_at DESC);

CREATE TABLE opportunity_match_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES opportunity_match_runs (id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  offering_id       uuid NOT NULL REFERENCES product_offerings (id) ON DELETE CASCADE,
  match_score       integer NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  commercial_potential integer NOT NULL CHECK (commercial_potential BETWEEN 0 AND 100),
  confidence        text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  eligible          boolean NOT NULL,
  suppression_override boolean NOT NULL DEFAULT false,
  factors           jsonb NOT NULL,
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_approach text NOT NULL CHECK (length(recommended_approach) BETWEEN 1 AND 4000),
  recommended_next_action text NOT NULL CHECK (length(recommended_next_action) BETWEEN 1 AND 500),
  note              text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, offering_id)
);
CREATE INDEX opportunity_match_results_company_idx
  ON opportunity_match_results (tenant_id, company_id, match_score DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_offerings, product_documents,
  opportunity_match_runs, opportunity_match_results TO app_rw;

CREATE TRIGGER product_offerings_updated_at BEFORE UPDATE ON product_offerings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product_offerings', 'product_documents',
    'opportunity_match_runs', 'opportunity_match_results'
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

INSERT INTO feature_flags (key, description, enabled) VALUES
  ('product_catalogue', 'Enable product/services catalogue APIs and UI', true),
  ('opportunity_matching', 'Enable company-to-offering matching (separate from ICP score)', true)
ON CONFLICT (key) DO NOTHING;

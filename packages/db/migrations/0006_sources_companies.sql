-- Global source registry (reference data) and tenant-private companies.
CREATE TABLE source_registry (
  id                text PRIMARY KEY,
  provider_name     text NOT NULL,
  source_type       text NOT NULL,
  terms_reference   text NOT NULL,
  allowed_purposes  text[] NOT NULL,
  retention_policy  text NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  is_mock           boolean NOT NULL DEFAULT false,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON source_registry TO app_rw;

INSERT INTO source_registry (id, provider_name, source_type, terms_reference, allowed_purposes, retention_policy, enabled, is_mock)
VALUES
  ('mock_web', 'Mock company website', 'company_website', 'synthetic-fixture', ARRAY['development', 'testing'], 'retain_90_days', true, true),
  ('mock_people', 'Mock people directory', 'licensed_provider', 'synthetic-fixture', ARRAY['development', 'testing'], 'retain_90_days', true, true),
  ('mock_registry', 'Mock public registry', 'public_registry', 'synthetic-fixture', ARRAY['development', 'testing'], 'retain_90_days', true, true);

CREATE TABLE companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  canonical_name    text NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 300),
  primary_domain    text NOT NULL CHECK (primary_domain = lower(primary_domain)),
  country_code      text CHECK (country_code ~ '^[A-Z]{2}$'),
  region            text,
  industry          text,
  employee_band     text,
  description       text,
  lifecycle_status  text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived')),
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, primary_domain)
);
CREATE INDEX companies_tenant_created_idx ON companies (tenant_id, created_at DESC, id DESC);
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE company_aliases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  alias               text NOT NULL,
  source_evidence_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, alias)
);

CREATE TABLE company_identifiers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  identifier_type     text NOT NULL,
  identifier_value    text NOT NULL,
  jurisdiction        text,
  source_evidence_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, identifier_type, identifier_value)
);

GRANT SELECT, INSERT, UPDATE ON companies, company_aliases, company_identifiers TO app_rw;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_tenant ON companies FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE company_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY company_aliases_tenant ON company_aliases FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE company_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY company_identifiers_tenant ON company_identifiers FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

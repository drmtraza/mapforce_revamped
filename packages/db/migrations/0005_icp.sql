-- Versioned ideal-customer-profile definitions. Updates insert a new version.
CREATE TABLE icp_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  profile_key  uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  version      integer NOT NULL CHECK (version >= 1),
  definition   jsonb NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_key, version)
);
CREATE UNIQUE INDEX icp_profiles_one_active_idx ON icp_profiles (tenant_id, profile_key) WHERE active;
CREATE INDEX icp_profiles_tenant_created_idx ON icp_profiles (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON icp_profiles TO app_rw;

ALTER TABLE icp_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY icp_profiles_tenant ON icp_profiles FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

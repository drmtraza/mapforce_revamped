-- Users, sessions, tenants and memberships.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_issuer    text NOT NULL,
  idp_subject   text NOT NULL,
  email         citext NOT NULL,
  display_name  text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp_issuer, idp_subject)
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sessions are looked up by token hash before any user/tenant context exists,
-- so they are not RLS-protected; only hashes of opaque tokens are stored.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  plan_id     text NOT NULL DEFAULT 'development',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL
              CHECK (role IN ('owner', 'admin', 'manager', 'researcher', 'representative', 'auditor')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

GRANT SELECT, UPDATE ON users TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_rw;
GRANT SELECT, INSERT, UPDATE ON tenants TO app_rw;
GRANT SELECT, INSERT, UPDATE ON memberships TO app_rw;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT TO app_rw
  USING (
    id = app_current_user()
    OR id IN (SELECT m.user_id FROM memberships m WHERE m.tenant_id = app_current_tenant())
  );
CREATE POLICY users_self_update ON users FOR UPDATE TO app_rw
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_visible ON memberships FOR SELECT TO app_rw
  USING (tenant_id = app_current_tenant() OR user_id = app_current_user());
CREATE POLICY memberships_write ON memberships FOR INSERT TO app_rw
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY memberships_update ON memberships FOR UPDATE TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_visible ON tenants FOR SELECT TO app_rw
  USING (
    id = app_current_tenant()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user() AND m.status = 'active'
    )
  );
CREATE POLICY tenants_insert ON tenants FOR INSERT TO app_rw
  WITH CHECK (id = app_current_tenant());
CREATE POLICY tenants_update ON tenants FOR UPDATE TO app_rw
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

-- Login runs before a user context exists; this narrowly scoped definer function
-- is the only path that can create or look up a user by identity-provider subject.
CREATE FUNCTION app_upsert_user_from_idp(p_issuer text, p_subject text, p_email text, p_display_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO users (idp_issuer, idp_subject, email, display_name)
  VALUES (p_issuer, p_subject, p_email, p_display_name)
  ON CONFLICT (idp_issuer, idp_subject)
  DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION app_upsert_user_from_idp(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_upsert_user_from_idp(text, text, text, text) TO app_rw;

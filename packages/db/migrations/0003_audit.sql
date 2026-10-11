-- Append-only audit trail. The runtime role can insert and read, never update or delete.
CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'system')),
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  outcome         text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  correlation_id  text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, created_at DESC) WHERE tenant_id IS NULL;

GRANT SELECT, INSERT ON audit_events TO app_rw;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_events FOR SELECT TO app_rw
  USING (
    tenant_id = app_current_tenant()
    OR (tenant_id IS NULL AND actor_user_id = app_current_user())
  );
CREATE POLICY audit_insert ON audit_events FOR INSERT TO app_rw
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant());

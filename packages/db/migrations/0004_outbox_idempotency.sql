-- Transactional outbox and HTTP idempotency records.
CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event_type       text NOT NULL,
  schema_version   integer NOT NULL DEFAULT 1,
  correlation_id   text NOT NULL,
  causation_id     uuid,
  idempotency_key  text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  dead_lettered_at timestamptz,
  UNIQUE (tenant_id, event_type, idempotency_key)
);
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

GRANT SELECT, INSERT ON outbox_events TO app_rw;
GRANT SELECT, UPDATE ON outbox_events TO app_relay;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON outbox_events FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- The relay publishes for all tenants but can only read and mark delivery state.
CREATE POLICY outbox_relay ON outbox_events FOR ALL TO app_relay USING (true) WITH CHECK (true);

CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  method           text NOT NULL,
  route            text NOT NULL,
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_expires_idx ON idempotency_keys (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_rw;

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_tenant ON idempotency_keys FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

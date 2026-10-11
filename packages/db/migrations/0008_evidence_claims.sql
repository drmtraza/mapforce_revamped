-- Source evidence and claims. Facts, provider facts and inferences are stored as typed claims.
CREATE TABLE evidence_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid REFERENCES companies (id) ON DELETE CASCADE,
  source_registry_id  text NOT NULL REFERENCES source_registry (id),
  workflow_job_id     uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  source_url          text NOT NULL CHECK (source_url ~ '^https?://'),
  fetched_at          timestamptz NOT NULL,
  published_at        timestamptz,
  content_hash        text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_type        text NOT NULL,
  storage_key         text,
  excerpt             text CHECK (length(excerpt) <= 2000),
  license_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_until     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_registry_id, source_url, content_hash)
);
CREATE INDEX evidence_tenant_company_idx ON evidence_records (tenant_id, company_id, fetched_at DESC);

CREATE TABLE claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject_type     text NOT NULL CHECK (subject_type IN ('company', 'person', 'employment_role')),
  subject_id       uuid NOT NULL,
  predicate        text NOT NULL,
  object_value     jsonb NOT NULL,
  claim_type       text NOT NULL
                   CHECK (claim_type IN ('source_fact', 'provider_fact', 'model_inference', 'user_assertion')),
  status           text NOT NULL DEFAULT 'current'
                   CHECK (status IN ('current', 'disputed', 'expired', 'retracted')),
  confidence       numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale        text,
  source_key       text REFERENCES source_registry (id),
  workflow_job_id  uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  observed_at      timestamptz NOT NULL,
  valid_from       timestamptz,
  valid_to         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id, predicate, source_key, object_value)
);
CREATE INDEX claims_subject_idx ON claims (tenant_id, subject_type, subject_id);

CREATE TABLE claim_evidence (
  claim_id            uuid NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  evidence_record_id  uuid NOT NULL REFERENCES evidence_records (id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  support_type        text NOT NULL DEFAULT 'supports' CHECK (support_type IN ('supports', 'contradicts')),
  excerpt_locator     text,
  PRIMARY KEY (claim_id, evidence_record_id)
);
CREATE INDEX claim_evidence_evidence_idx ON claim_evidence (tenant_id, evidence_record_id);

GRANT SELECT, INSERT, UPDATE ON evidence_records, claims, claim_evidence TO app_rw;

ALTER TABLE evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_records FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_records_tenant ON evidence_records FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
CREATE POLICY claims_tenant ON claims FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_evidence_tenant ON claim_evidence FOR ALL TO app_rw
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

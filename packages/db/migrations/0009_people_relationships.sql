-- Tenant-private people, role history, reviews and the relational organization graph.
CREATE TABLE people (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  canonical_name      text NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 200),
  normalized_name     text NOT NULL,
  public_profile_url  text CHECK (public_profile_url ~ '^https?://'),
  review_status       text NOT NULL DEFAULT 'unreviewed'
                      CHECK (review_status IN ('unreviewed', 'accepted', 'rejected', 'disputed')),
  reviewed_by         uuid REFERENCES users (id),
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1
);
CREATE INDEX people_tenant_name_idx ON people (tenant_id, normalized_name);
CREATE TRIGGER people_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employment_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  title       text,
  department  text,
  seniority   text,
  start_date  date,
  end_date    date,
  status      text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'past', 'unknown')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, person_id, company_id, title)
);
CREATE INDEX employment_roles_company_idx ON employment_roles (tenant_id, company_id);

CREATE TABLE person_company_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_id            uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  company_id           uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  relationship_status  text NOT NULL CHECK (relationship_status IN ('current', 'past', 'unknown')),
  confidence           numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from           timestamptz,
  valid_to             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, person_id, company_id)
);
CREATE INDEX person_company_links_company_idx ON person_company_links (tenant_id, company_id);

CREATE TABLE person_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  decision       text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'disputed')),
  reason         text CHECK (length(reason) <= 2000),
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_reviews_person_idx ON person_reviews (tenant_id, person_id, created_at DESC);

CREATE TABLE relationships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject_type     text NOT NULL CHECK (subject_type IN ('person', 'company')),
  subject_id       uuid NOT NULL,
  predicate        text NOT NULL
                   CHECK (predicate IN ('WORKS_AT', 'HOLDS_ROLE', 'REPORTS_TO', 'INFLUENCES', 'DECIDES_FOR',
                                        'WORKS_WITH', 'USES_TECHNOLOGY', 'HIRING_FOR', 'EVIDENCED_BY')),
  object_type      text NOT NULL CHECK (object_type IN ('person', 'company', 'technology', 'role')),
  object_id        uuid NOT NULL,
  status           text NOT NULL CHECK (status IN ('verified', 'inferred', 'disputed', 'expired')),
  claim_type       text NOT NULL
                   CHECK (claim_type IN ('source_fact', 'provider_fact', 'model_inference', 'user_assertion')),
  confidence       numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale        text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  source_key       text REFERENCES source_registry (id),
  workflow_job_id  uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  valid_from       timestamptz,
  valid_to         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id, predicate, object_type, object_id),
  -- A model inference can never be stored as a verified relationship.
  CHECK (NOT (claim_type = 'model_inference' AND status = 'verified'))
);
CREATE INDEX relationships_subject_idx ON relationships (tenant_id, subject_type, subject_id);
CREATE INDEX relationships_object_idx ON relationships (tenant_id, object_type, object_id);
CREATE TRIGGER relationships_updated_at BEFORE UPDATE ON relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE relationship_evidence (
  relationship_id     uuid NOT NULL REFERENCES relationships (id) ON DELETE CASCADE,
  evidence_record_id  uuid NOT NULL REFERENCES evidence_records (id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (relationship_id, evidence_record_id)
);

GRANT SELECT, INSERT, UPDATE ON people, employment_roles, person_company_links, person_reviews,
  relationships, relationship_evidence TO app_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people', 'employment_roles', 'person_company_links', 'person_reviews',
                           'relationships', 'relationship_evidence']
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

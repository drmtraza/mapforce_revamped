-- Phase 3: role-history support, match/merge, contact status, suppressions, intent signals.
-- As-built numbering: 0010 is discovery/imports; this file is 0011.

ALTER TABLE people
  ADD COLUMN merged_into_id uuid REFERENCES people (id);
ALTER TABLE people
  ADD CONSTRAINT people_merged_into_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id);
CREATE INDEX people_merged_into_idx ON people (tenant_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE TABLE person_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  alias       text NOT NULL CHECK (length(alias) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, person_id, alias)
);
CREATE INDEX person_aliases_person_idx ON person_aliases (tenant_id, person_id);

CREATE TABLE match_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_a_id   uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  person_b_id   uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  score         numeric(4, 3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  rationale     text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'accepted', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users (id),
  CHECK (person_a_id < person_b_id),
  UNIQUE (tenant_id, person_a_id, person_b_id)
);
CREATE INDEX match_candidates_status_idx ON match_candidates (tenant_id, status);

CREATE TABLE person_merges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  survivor_id         uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  absorbed_id         uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  match_candidate_id  uuid REFERENCES match_candidates (id),
  actor_user_id       uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  undone_at           timestamptz,
  CHECK (survivor_id <> absorbed_id)
);
CREATE UNIQUE INDEX person_merges_active_absorbed_idx
  ON person_merges (tenant_id, absorbed_id) WHERE undone_at IS NULL;

CREATE TABLE contact_points (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  person_id               uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  company_id              uuid REFERENCES companies (id) ON DELETE SET NULL,
  contact_type            text NOT NULL CHECK (contact_type IN ('work_email', 'work_phone')),
  normalized_value_hash   text NOT NULL CHECK (normalized_value_hash ~ '^[0-9a-f]{64}$'),
  display_hint            text NOT NULL CHECK (length(display_hint) BETWEEN 1 AND 320),
  value_ciphertext        bytea NOT NULL,
  value_iv                bytea NOT NULL,
  value_tag               bytea NOT NULL,
  status                  text NOT NULL
                          CHECK (status IN (
                            'unverified', 'provider_verified', 'deliverable_likely',
                            'invalid', 'catch_all', 'unknown', 'suppressed'
                          )),
  verification_method     text NOT NULL
                          CHECK (verification_method IN ('none', 'pattern', 'mx', 'provider', 'user')),
  verified_at             timestamptz,
  claim_type              text NOT NULL
                          CHECK (claim_type IN ('source_fact', 'provider_fact', 'model_inference', 'user_assertion')),
  confidence              numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_key              text REFERENCES source_registry (id),
  source_evidence_id      uuid REFERENCES evidence_records (id) ON DELETE SET NULL,
  workflow_job_id         uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  observed_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, person_id, contact_type, normalized_value_hash),
  CHECK (
    verification_method NOT IN ('none', 'pattern', 'mx')
    OR status <> 'provider_verified'
  ),
  CHECK (
    status <> 'provider_verified'
    OR (verification_method = 'provider' AND verified_at IS NOT NULL)
  )
);
CREATE INDEX contact_points_person_idx ON contact_points (tenant_id, person_id);
CREATE INDEX contact_points_hash_idx ON contact_points (tenant_id, normalized_value_hash);

CREATE TABLE consent_suppressions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('email', 'phone', 'domain', 'person')),
  value_hash    text NOT NULL CHECK (value_hash ~ '^[0-9a-f]{64}$'),
  display_hint  text NOT NULL CHECK (length(display_hint) BETWEEN 1 AND 320),
  reason        text CHECK (length(reason) <= 2000),
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, value_hash)
);
CREATE INDEX consent_suppressions_hash_idx ON consent_suppressions (tenant_id, subject_type, value_hash);

CREATE TABLE intent_signals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  signal_type      text NOT NULL
                   CHECK (signal_type IN ('hiring', 'funding', 'procurement', 'news', 'product', 'other')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  summary          text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  implies_budget   boolean NOT NULL DEFAULT false,
  claim_type       text NOT NULL
                   CHECK (claim_type IN ('source_fact', 'provider_fact', 'model_inference', 'user_assertion')),
  confidence       numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  country_code     text CHECK (country_code ~ '^[A-Z]{2}$'),
  observed_at      timestamptz NOT NULL,
  source_key       text NOT NULL REFERENCES source_registry (id),
  workflow_job_id  uuid REFERENCES workflow_jobs (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (signal_type <> 'hiring' OR implies_budget = false)
);
CREATE INDEX intent_signals_company_idx ON intent_signals (tenant_id, company_id, observed_at DESC);

CREATE TABLE signal_evidence (
  signal_id           uuid NOT NULL REFERENCES intent_signals (id) ON DELETE CASCADE,
  evidence_record_id  uuid NOT NULL REFERENCES evidence_records (id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (signal_id, evidence_record_id)
);

ALTER TABLE workflow_jobs ADD COLUMN person_id uuid REFERENCES people (id) ON DELETE SET NULL;
ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_job_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_job_type_check
  CHECK (job_type IN ('company_research', 'company_discovery', 'person_enrichment'));
ALTER TABLE workflow_jobs DROP CONSTRAINT IF EXISTS workflow_jobs_research_has_company;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_research_has_company
  CHECK (job_type <> 'company_research' OR company_id IS NOT NULL);
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_enrichment_has_person
  CHECK (job_type <> 'person_enrichment' OR (company_id IS NOT NULL AND person_id IS NOT NULL));

INSERT INTO source_registry (
  id, provider_name, source_type, terms_reference, allowed_purposes, retention_policy,
  enabled, is_mock, description, operations, requires_credentials, default_tenant_enabled,
  freshness_ttl_hours, retention_days, max_requests_per_job
) VALUES
  ('mock_careers', 'Mock careers / job board', 'job_board', 'synthetic-fixture',
   ARRAY['development', 'testing'], 'retain_90_days', true, true,
   'Deterministic synthetic hiring signals. Hiring is never treated as budget.',
   ARRAY['fetch_intent_signals'], false, true, 168, 90, 1),
  ('mock_procurement', 'Mock public procurement', 'procurement', 'synthetic-fixture',
   ARRAY['development', 'testing'], 'retain_90_days', true, true,
   'Deterministic synthetic US/UK/EU public-procurement notices.',
   ARRAY['fetch_intent_signals'], false, true, 168, 90, 1),
  ('mock_contacts', 'Mock contact enrichment', 'contact_provider', 'synthetic-fixture',
   ARRAY['development', 'testing'], 'retain_90_days', true, true,
   'Pattern-guesses a work email from name + domain. Status is always unverified.',
   ARRAY['enrich_contact'], false, true, 168, 30, 1),
  ('licensed_contacts', 'Licensed contact provider', 'contact_provider',
   'Owner review of provider terms required before enabling (decision D12).',
   ARRAY['b2b_research'], 'retain_30_days', false, false,
   'Licensed contact enrichment. Globally disabled until credentials and terms are approved.',
   ARRAY['enrich_contact'], true, false, 168, 30, 1);

GRANT SELECT, INSERT, UPDATE ON person_aliases, match_candidates, person_merges,
  contact_points, consent_suppressions, intent_signals, signal_evidence TO app_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'person_aliases', 'match_candidates', 'person_merges', 'contact_points',
    'consent_suppressions', 'intent_signals', 'signal_evidence'
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

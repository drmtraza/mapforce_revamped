-- Phase 5: explainable scoring, BD workspace, controlled export and tenant budget overrides.

CREATE TABLE scoring_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  version         integer NOT NULL CHECK (version >= 1),
  weights         jsonb NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX scoring_policies_one_active_idx
  ON scoring_policies (tenant_id) WHERE active;

CREATE TABLE score_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  icp_profile_id      uuid NOT NULL REFERENCES icp_profiles (id),
  scoring_policy_id   uuid NOT NULL REFERENCES scoring_policies (id),
  scoring_version     integer NOT NULL,
  total_score         integer NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  eligible            boolean NOT NULL,
  suppression_override boolean NOT NULL DEFAULT false,
  factors             jsonb NOT NULL,
  explanation         text NOT NULL CHECK (length(explanation) BETWEEN 1 AND 4000),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX score_runs_company_idx ON score_runs (tenant_id, company_id, created_at DESC);

CREATE TABLE account_assignments (
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  owner_user_id   uuid REFERENCES users (id),
  stage           text NOT NULL DEFAULT 'identified'
                  CHECK (stage IN (
                    'identified', 'researching', 'qualified', 'outreach',
                    'meeting', 'closed_won', 'closed_lost', 'on_hold'
                  )),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  next_action_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id)
);

CREATE TABLE workspace_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind            text NOT NULL CHECK (kind IN ('companies', 'people')),
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE list_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  list_id         uuid NOT NULL REFERENCES workspace_lists (id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('company', 'person')),
  entity_id       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, entity_type, entity_id)
);
CREATE INDEX list_items_list_idx ON list_items (tenant_id, list_id, created_at DESC);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies (id) ON DELETE CASCADE,
  person_id       uuid REFERENCES people (id) ON DELETE SET NULL,
  owner_user_id   uuid REFERENCES users (id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description     text CHECK (length(description) <= 4000),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_at          timestamptz,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_company_idx ON tasks (tenant_id, company_id, created_at DESC);

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies (id) ON DELETE CASCADE,
  person_id       uuid REFERENCES people (id) ON DELETE SET NULL,
  author_user_id  uuid NOT NULL REFERENCES users (id),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_company_idx ON notes (tenant_id, company_id, created_at DESC);

CREATE TABLE export_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  scope               text NOT NULL CHECK (scope IN ('companies', 'list')),
  list_id             uuid REFERENCES workspace_lists (id) ON DELETE SET NULL,
  filename            text NOT NULL,
  row_count           integer NOT NULL CHECK (row_count >= 0),
  omitted_suppressed  integer NOT NULL DEFAULT 0 CHECK (omitted_suppressed >= 0),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_budgets (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  daily_research_job_limit    integer CHECK (daily_research_job_limit BETWEEN 0 AND 100000),
  daily_enrich_limit          integer CHECK (daily_enrich_limit BETWEEN 0 AND 100000),
  daily_ai_run_limit          integer CHECK (daily_ai_run_limit BETWEEN 0 AND 100000),
  daily_export_limit          integer CHECK (daily_export_limit BETWEEN 0 AND 100000),
  updated_by                  uuid REFERENCES users (id),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER account_assignments_updated_at BEFORE UPDATE ON account_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notes_updated_at BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON scoring_policies, score_runs, account_assignments,
  workspace_lists, list_items, tasks, notes, export_batches, tenant_budgets TO app_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'scoring_policies', 'score_runs', 'account_assignments', 'workspace_lists',
    'list_items', 'tasks', 'notes', 'export_batches', 'tenant_budgets'
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

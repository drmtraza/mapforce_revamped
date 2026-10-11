#!/bin/sh
# Creates the runtime login roles used by the API (RLS-enforced) and the outbox relay.
# The schema owner (POSTGRES_USER) runs migrations; runtime roles never own tables.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_relay') THEN
    CREATE ROLE app_relay NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapforce_app') THEN
    CREATE ROLE mapforce_app LOGIN NOBYPASSRLS PASSWORD '${APP_DB_PASSWORD}' IN ROLE app_rw;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapforce_relay') THEN
    CREATE ROLE mapforce_relay LOGIN NOBYPASSRLS PASSWORD '${RELAY_DB_PASSWORD}' IN ROLE app_relay;
  END IF;
END
\$\$;
SQL

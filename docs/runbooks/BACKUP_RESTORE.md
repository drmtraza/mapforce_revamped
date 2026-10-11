# Runbook — backup and restore

## Scope

PostgreSQL is canonical. Object storage (evidence blobs) and Temporal workflow history are derived or replayable and must be restored separately if they are in use.

Hosting cloud (D13) is not chosen. This runbook assumes managed Postgres with PITR **or** the local compose volume.

## Proposed objectives (not contracted)

- RPO ≤ 15 minutes (PITR / WAL archive) once a managed host exists.
- RTO ≤ 4 hours for core transactional data.

These numbers are proposals from `QUALITY_AND_SCALE_PLAN.md`. They are not measured on a production host.

## Local compose drill

1. `pnpm infra:up` and `pnpm db:migrate`.
2. Create a workspace and one company in the UI (synthetic data only).
3. Dump:

```bash
docker compose -f infra/compose/docker-compose.yml exec -T postgres \
  pg_dump -U mapforce_owner --no-owner --no-acl mapforce > /tmp/mapforce.dump.sql
```

4. Restore into a throwaway database or container. Do not restore over a live tenant store.
5. Confirm `SELECT canonical_name FROM companies` returns the synthetic row.

Automated evidence: `packages/db/test/backup-restore.integration.test.ts` runs `pg_dump` inside Testcontainers and restores into a second Postgres 16 container.

## Production (when D13 is decided)

- Enable encrypted automated backups and PITR on managed Postgres.
- Store dumps in a separate account; encrypt at rest.
- Schedule a restore drill at least quarterly; record date, SHA, duration, and gaps.
- After restore, rotate session secrets if the dump could have contained hashed session material.
- Replay Temporal / rebuild search only after Postgres is consistent.

## Rollback of migration 0014

Forward-only. If 0014 must be undone, restore from backup taken before migrate and replay later migrations. Dropping `workspace_controls` loses kill-switch overrides.

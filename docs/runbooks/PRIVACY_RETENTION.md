# Privacy and retention verification (Phase 6)

## What is stored

| Class | Store | Retention |
|---|---|---|
| Company / person / claims | Postgres | Until workspace deletion or legal hold |
| Evidence excerpt + blob key | Postgres + object storage | `retention_until` from the source’s `retention_days` |
| Contact values | Postgres, AES-256-GCM | Until person delete / suppression |
| Suppression | Hash only (`value_hash`) | Retained so suppressed subjects are not re-imported |
| Audit | Append-only | Longer than evidence; no contact plaintext |
| AI prompts / results | `ai_runs` / `ai_quarantine` | Same tenant RLS as companies |

## Verified in this phase

- `GET /ops/retention` counts expired evidence that still has an excerpt.
- `POST /ops/retention-sweep` redacts up to 100 expired excerpts per call. It does **not** delete suppression hashes, contact ciphertext, or audit rows.
- Integration test updates `retention_until` into the past, sweeps, and asserts excerpts are gone.
- Cross-tenant sweep cannot see another tenant’s rows (RLS + API workspace header).

## Not verified

- Object-storage lifecycle delete of the blob behind `storage_key`.
- Search/graph projections (none exist yet).
- Legal hold / DSAR export package.
- Production backup encryption (D13).

## Operator steps

1. Review Settings → Operations for the expired-excerpt count.
2. Run “Redact expired excerpts” (owner/admin). Repeat until the count is 0.
3. Blob deletion is a follow-up job once object-storage lifecycle rules are configured.

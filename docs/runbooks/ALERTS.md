# Runbook — alerts and dashboards

Scrape `GET /metrics` from a private network only. Series are process-local and must not include tenant IDs.

Import `infra/observability/grafana-mapforce.json` into Grafana after adding a Prometheus scrape of the API.

## Suggested rules (tune after a baseline)

| Condition | Severity | Action |
|---|---|---|
| `mapforce_up == 0` for 2m | P1 | Check process / container restart |
| `mapforce_db_pool_waiting > 0` for 5m | P2 | Raise `DATABASE_POOL_MAX` only after checking slow queries |
| `rate(mapforce_http_errors_total[5m]) > 0.05` | P2 | Inspect correlation IDs; look at Temporal and providers |
| `increase(mapforce_rate_limited_total[10m]) > 100` | P3 | Abuse or a client loop; do not raise limits blindly |
| Readyz 503 | P1 | Postgres or Redis |

Queue age is not yet a Prometheus series. Use `GET /api/v1/usage` and Temporal UI until a worker exporter exists.

These thresholds are starting points, not SLOs.

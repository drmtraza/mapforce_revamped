# Quality, Performance and Scale Validation Plan

## 1. Capacity is a testable hypothesis
The targets of 1M registered users and 10K concurrent users do not define traffic by themselves. Before sizing infrastructure, define:
- Active sessions and request rate per concurrent user.
- Read/write mix, list/filter complexity, dashboard refresh frequency.
- Research jobs submitted per minute and average sources/pages per job.
- Average and p95 provider latency, provider quotas and failure rates.
- AI requests per minute, prompt size, model throughput and GPU/API budgets.
- Data retention, evidence volume and growth rate.

## 2. Initial service-level objectives (proposed)
These are initial engineering targets and should be adjusted after baseline measurement:
- Core API availability: 99.9% monthly target.
- Indexed ordinary read API p95 <300 ms under agreed load.
- Ordinary write API p95 <500 ms excluding long-running external work.
- Job submission p95 <300 ms.
- No cross-tenant data leakage in automated tests.
- Queue age and provider errors visible; alert thresholds set per workload.
- Data loss objective and recovery time objective agreed before production; initial proposal RPO <=15 minutes and RTO <=4 hours for core transactional data, subject to hosting capabilities.

## 3. Test layers
### Unit
Validation, scoring factors, entity normalization, deduplication, source freshness, suppression precedence, tenant authorization, retry policy and schema parsing.

### Integration
PostgreSQL migrations, outbox delivery, workflow retries, object storage, Redis behavior, provider mocks, AI schema validation and deletion propagation.

### Contract
OpenAPI, JSON Schema, provider adapter response fixtures, event version compatibility and mock/real adapter parity.

### End-to-end
Signup/workspace creation; import; research job; partial source failure; lead review; scoring; organization map; draft generation; export suppression; deletion; audit review.

### Security
Cross-tenant IDOR, RBAC bypass, SSRF, stored/reflected XSS, CSRF where relevant, injection, CSV formula injection, secrets exposure, rate-limit bypass, mass assignment, export authorization and prompt injection.

### Load and soak
- API baseline: 100, 500, 1,000, then 10,000 simulated concurrent sessions where tooling and budget permit.
- Separate tests for 10K persistent/mostly idle sessions vs 10K active users; these are different workloads.
- Test read-heavy and mixed workloads with realistic tenant skew.
- Burst job submission, provider throttling, queue backlog, worker restart and dead-letter recovery.
- 1–4 hour soak test; check memory leaks, pool exhaustion, queue age and cost.
- Failure injection for database failover, Redis outage, provider timeout, AI outage and object-storage failure.
- Do not use live provider endpoints for load tests unless the provider explicitly authorizes it.

## 4. Capacity acceptance
Before asserting the scale target, document:
- Exact workload model and test scripts.
- Dataset size and distribution.
- API latency percentiles and error rate.
- Database CPU/IO/connection utilization.
- Queue throughput and maximum age.
- Worker memory/CPU and autoscaling behavior.
- Provider quota ceilings.
- Cost per 1,000 accounts and cost per qualified lead.
- Bottlenecks and remediation.
- Test date, commit SHA and environment.

## 5. Data quality evaluation
Track:
- Company match precision/recall on a manually labelled set.
- Person-to-company association accuracy.
- Current role accuracy and freshness.
- Email status distribution and observed bounce rate only when measured through legitimate campaigns.
- Duplicate rate.
- Evidence citation validity.
- AI unsupported-claim rate.
- Organization-edge precision, with high penalty for false reporting-line claims.
- Intent signal usefulness judged by BD users.
- User correction and suppression rates.

## 6. Release gates
- No P0/P1 security issues.
- Tenant isolation suite passes.
- Database migrations tested forward and rollback strategy documented.
- Backup restore verified.
- Critical user journeys pass E2E.
- Provider kill switch and spending caps tested.
- Error budgets, dashboards and runbooks exist.
- Load-test results reviewed; known limitations documented.

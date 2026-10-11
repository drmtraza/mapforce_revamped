# Phase 2 report — discovery and evidence

Branch: `phase-2/discovery-evidence` (from `phase-1/foundation-vertical-slice`).
Scope: `DELIVERY_ROADMAP.md` Phase 2 and `IMPLEMENTATION_PLAN.md` §6 row 2. This report states what exists, how it was verified, and what is not done. It makes no production-readiness or capacity claim.

## 1. What was built

| Area | Location | Notes |
|---|---|---|
| Migration 0010 | `packages/db/migrations/0010_discovery_imports.sql` | Source policy columns, tenant source settings, discovery candidates, CSV import tables, DLQ replay grant |
| Adapter interface | `workers/research/.../adapters/base.py` | All six methods; `fetch_intent_signals` / `enrich_contact` cannot be dispatched until Phase 3 has a result contract |
| Mock search | `MockSearchAdapter` | Default discovery source; queries containing `outage` fail in isolation |
| Company-site crawler | `adapters/company_site.py`, `net.py` | robots.txt, SSRF (private/link-local/metadata/DNS rebinding), per-domain delay, page/byte budgets; off per workspace by default (D15) |
| Brave Search | `adapters/brave_search.py` | Registered, globally disabled, requires `BRAVE_SEARCH_API_KEY`; never auto-creates companies (D14) |
| CSV import | `apps/api/src/modules/imports` | Dry-run default, idempotent commit, tenant-scoped domain dedupe, user_assertion provenance |
| Discovery API | `apps/api/src/modules/discovery` | Search, cancel, accept/dismiss; candidates stay uncreated until review |
| Source settings + freshness | `apps/api/src/modules/sources` | Global kill switch stays owner-managed; workspace opt-in audited |
| Dead-letter replay | `GET/POST /api/v1/dead-letters` | Tenant-scoped; payload not exposed |
| UI | Discovery, Imports, Settings, company freshness | Accessibility-checked in Playwright |

## 2. Verification (commands actually run)

| Command | Result |
|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | Clean (web typecheck after UI) |
| `pnpm --filter @mapforce/contracts test` | 19/19 |
| `pnpm --filter @mapforce/api test` | 46/46 |
| `pnpm --filter @mapforce/api test:integration` | 50/50 (32 Phase 1 + 18 Phase 2) |
| `uv run ruff check . && uv run pytest` (workers/research) | clean; 79/79 |
| `pnpm --filter @mapforce/web build` | succeeds; new routes present |
| Playwright E2E against the live local stack | 4/4: Phase 1 journey still passes; Alice dry-runs and commits a CSV, runs mock discovery, accepts a candidate, opts in to the crawler; Bob cannot open Alice's workspace discovery |

## 3. Acceptance / exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| CSV import with dry-run and dedupe | Met | integration + UI |
| Source registry and adapter interface | Met | 0010 + `BaseAdapter` |
| One permitted search API, flagged off | Met | `brave_search` disabled; mock_search used locally |
| Public company-site crawler with robots/SSRF/budgets | Met | Python SSRF suite + integration policy tests |
| Partial success, cancel, DLQ + replay | Met | Phase 1 workflow plus dead-letter API tests |
| Provider failure isolated | Met | mock_search `outage` and mock_registry fail without discarding other sources |
| Evidence provenance inspectable | Met | discovery candidates require evidence; import claims are `user_assertion` |
| Tenant isolation for new surfaces | Met | Bob cannot read Alice's sources, searches, imports or dead letters |
| Duplicate imports do not create duplicate companies | Met | unique domain + existing outcome |

## 4. Owner decisions applied

- **D10** geography: country presets remain US / UK / EU+EEA+CH. No live registry adapter yet; Companies House / EDGAR / TED stay evaluation candidates.
- **D14** Brave Search: globally disabled, key required on the worker, results are candidates only.
- **D15** company-site crawler: off per workspace; owners/admins opt in (audited).

## 5. Configuration and operational changes

New or changed variables (placeholders only in `.env.example`):

- `TENANT_DAILY_CRAWL_PAGE_LIMIT` (API)
- `FEATURE_COMPANY_SITE_CRAWLER`, `CRAWLER_INFO_URL`, `BRAVE_SEARCH_API_KEY` (research worker)

Compose research-worker now passes the mock and crawler flags. Brave stays empty.

## 6. Known risks and gaps

- Live Brave Search is not exercised in CI (no credentials). Parity with mock_search is structural (same schema), not live-network.
- The crawler is identified and robots-respecting; it is not a general-purpose web spider and will not follow off-domain links.
- Rate limiting is still mostly by IP (Phase 1 risk).
- One-command demo is still incomplete (API/web/control worker run on the host).
- No load testing; no capacity claim.

## 7. Next step

Phase 3 (people, enrichment, signals) starts only after owner review of this report.

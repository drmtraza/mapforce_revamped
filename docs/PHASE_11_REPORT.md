# Phase 11 report — Baseline audit and extension design

Branch: `phase-11/baseline-audit`  
Date: 2026-11-15  
Remote: https://github.com/drmtraza/mapforce_revamped  
Baseline: `phase-10/release-smoke` (`d30ebeb`)

**Status: AWAITING PRODUCT OWNER APPROVAL.**  
This phase is **documentation and planning only**. No product code, schema, API contract, scoring, RBAC, or provider enablement was changed. Phases 12+ must not start until this report is approved.

This report does **not** claim GA readiness, Contabo/VPS deployment, live licensed enrichment, live Hermes, Stripe billing, or proven 10K-session capacity.

---

## 1. Executive verdict

Mapforce on `phase-10/release-smoke` is a coherent **trust-first B2B lead intelligence + BD workspace beta**. The proposed expansion into an **Agentic Business Development Operating System** is feasible as an **additive** program if:

1. Existing scoring semantics, suppression, no-auto-send, tenant isolation, and mock-vs-live distinctions are preserved.
2. New commercial scores (product match, commercial potential) stay **separate** from ICP account score (`icp-explainable/1.0.0`).
3. Agents stay behind budgets, feature flags, typed schemas, and human approval gates.
4. Payment processing and live paid providers remain owner-gated (D12 / billing approval).
5. Infrastructure stays lean: Postgres + Temporal + vector search first; Neo4j/Kafka/K8s only with measured need.

Recommended first build slice after approval: **Phase 12 — Product catalogue + opportunity matching** (highest commercial differentiation, lowest conflict with existing CRM).

---

## 2. Baseline inventory (as built)

### 2.1 Technology stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces (`apps/*`, `packages/*`); Python worker outside pnpm |
| API | TypeScript, Fastify 5, Zod, Temporal TS, openid-client, ioredis, S3 SDK |
| Web | Next.js 16 App Router, React 19 |
| DB | PostgreSQL 16, Kysely, SQL migrations, FORCE RLS |
| Workers | Python 3.12 Temporal activities (uv) |
| Infra | Compose: Postgres, Redis, Temporal, RustFS, Keycloak, research-worker |
| CI | lint/typecheck/unit/integration/python/security/images/compose/smoke/e2e |
| Packaging | API/web/research Dockerfiles; GHCR release workflow; Contabo/VPS not provisioned |

### 2.2 Existing product modules (preserve)

| Capability | Location (representative) |
|---|---|
| Workspaces + RBAC | `workspaces`, `http/context`, `rbac.ts` |
| ICP (versioned) | `icp` |
| Companies + evidence | `companies`, `evidence`, `research` |
| CSV import / discovery | `imports`, `discovery`, `sources` |
| People / contacts / enrich | `people`, `enrichment`, `contacts/crypto` |
| Signals | `signals` |
| Org-map + AI (mock default) | `orgmap`, `ai/` |
| Explainable scoring | `scoring` (`DEFAULT_WEIGHTS` 30/20/20/15/15) |
| Pipeline / lists / CRM | `accounts`, `lists`, `crm` |
| Outreach drafts (no send) | `orgmap` draft approve/reject |
| Suppression + export | `suppressions`, `exports` |
| Usage / budgets / rollout | `usage`, `budgets`, `rollout` |
| Ops / audit / packaging | `ops`, `audit`, Phase 9–10 deploy smoke |

### 2.3 Current navigation (`apps/web/.../layout.tsx`)

Companies · Pipeline · Lists · Discovery · Imports · Ideal customer profiles · Audit trail · Settings

### 2.4 Migrations

`0001`–`0015` (foundation → controlled rollout). Next expansion migrations start at **`0016_*`**.

### 2.5 Feature / provider gates (must stay honest)

| Gate | Default | Notes |
|---|---|---|
| Mock providers | on | Local/dev default |
| Brave Search | off | Needs key + terms + flags |
| Company-site crawler | adapter on; workspace opt-in | Robots/SSRF/budgets |
| Licensed contacts | off | **D12** |
| Hermes | off | Needs URL + flag |
| Auto email sequences | not built | Must stay human-reviewed drafts |
| Stripe / payment | not built | Entitlements may precede payment |
| DB feature flags | `live_search`, `licensed_contacts`, `hermes`, `bulk_export` false; `beta_feedback` true | |

### 2.6 Temporal workflows

`researchCompanyWorkflow`, `discoverCompaniesWorkflow`, `enrichPersonWorkflow`. Org-map AI runs in API control plane (not Temporal).

### 2.7 Regression baseline (this audit)

| Check | Result |
|---|---|
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| API unit | **68 passed** |
| contracts | **29 passed** |
| `pnpm format:check` | blocked by Windows `EPERM` on `workers/research/.pytest_cache` (env issue; not a code format failure) |
| Full integration / e2e / python / packaging-smoke | **not re-run in this audit session**; CI on `phase-10` remains the prior green reference. Re-run before Phase 12 coding starts. |

---

## 3. Feature-preservation matrix

| Existing approved behaviour | Preserve? | Expansion rule |
|---|---|---|
| Tenant isolation + RLS | **Yes** | Agency/white-label must not cross client data |
| ICP versioning | **Yes** | Catalogue ICP criteria are additive |
| Scoring weights 30/20/20/15/15 + version label | **Yes** | Product-match / commercial scores = **new metrics**, not silent redefinition of account score |
| Hiring ≠ confirmed budget | **Yes** | Opportunity matching must keep the same language |
| Contact status honesty (no guessed = verified) | **Yes** | Agents cannot invent verified contacts |
| Suppression overrides score/lists/export/outreach | **Yes** | Agents/copilot/NBA must honour suppression |
| No automatic outreach send | **Yes** | Drafts + human approve/reject only |
| Mock ≠ live providers | **Yes** | UI/docs must label disabled/mock |
| Workspace budgets + kill switches | **Yes** | Agent/mission spend uses same budget gates |
| Audit events | **Yes** | New modules emit audit actions |
| Outreach drafts workflow | **Yes** | Proposal studio is additive, not a replacement |
| Pipeline stages on `account_assignments` | **Yes** | Revenue opportunities may add stages **compatibly** |
| D12 licensed contacts off | **Yes** | Until owner procurement |
| D13 hosting open / Contabo optional | **Yes** | Packaging docs only; no fake “deployed” claims |
| Billing not integrated | **Yes** | Metering/entitlements before Stripe |

### Conflicts requiring explicit owner approval (STOP if coding would change these)

1. Changing `DEFAULT_WEIGHTS` or `SCORING_VERSION_LABEL` semantics.  
2. Equating ICP fit with buying intent or win probability.  
3. Enabling licensed enrichment or Hermes as “live” without credentials/terms.  
4. Auto-sending email or auto-submitting bids.  
5. Auto-mutating pipeline stage from meeting AI alone.  
6. Weakening RLS for agency parent→child access (must be explicit membership model).  
7. Introducing Neo4j/Kafka/K8s without measured workload justification.

---

## 4. Architecture extension plan (additive)

Keep the **modular monolith control plane** + Temporal workers. Add domain modules as folders under `apps/api/src/modules/` and optional Python adapters under `workers/research`. Do **not** split into many microservices for appearance.

```text
┌─────────────────────────────────────────────────────────────┐
│ Web (Next) — additive nav sections behind feature flags     │
└───────────────────────────┬─────────────────────────────────┘
                            │ /api/v1 (versioned)
┌───────────────────────────▼─────────────────────────────────┐
│ Fastify control plane                                       │
│  existing: research, scoring, crm, rollout, ai (mock/Hermes)│
│  new: catalogue, matching, radar, missions, agents,         │
│       account_intel, tenders, proposals, revenue, nba, …    │
│  AI Gateway (multi-provider, budgets, structured outputs)   │
│  Agent Orchestrator (Temporal-backed; human gates)          │
└───────┬───────────────┬───────────────┬─────────────────────┘
        │               │               │
   PostgreSQL(+pgvector │          Temporal
   later if justified)  │          research-control /
        │               │          research-python /
   Evidence S3          │          agent-missions (new queue)
        │               │
   Provider adapters (flagged; mock default)
```

### 4.1 AI Gateway (Phase 14+)

- Interface already sketched by `modules/ai` (mock + Hermes).  
- Extend to OpenAI / Anthropic / Gemini **adapters** behind config.  
- Structured JSON schema validation + quarantine pattern reused from org-map.  
- Token/cost → `provider_usage` / new `ai_cost_records`; tenant ceilings enforced.

### 4.2 Agent runtime (Phase 14+)

- Prefer **Temporal workflows** for durability (already in stack) over introducing LangGraph as a second orchestrator unless Temporal proves insufficient for graph branching.  
- Evaluate LangGraph as an **in-process planner** only if it simplifies tool graphs; persistence/checkpoints remain Temporal.  
- MCP: optional tool bus later; least privilege; no raw DB SQL tools for agents.  
- Every agent: Zod I/O, tool allowlist, timeout, retry bound, provenance, audit, kill switch.

### 4.3 Search / knowledge

- Start: Postgres full-text + existing evidence.  
- Add embeddings (`pgvector` or external) when catalogue + evidence RAG justified.  
- Neo4j deferred.

### 4.4 Data model principle

Conceptual entities in the master prompt map to **new tables** only when no equivalent exists. Prefer overlays on `companies`, `people`, `relationships`, `intent_signals`, `account_assignments`, `tasks`, `notes`, `outreach_drafts`, `tenant_budgets`.

---

## 5. Module mapping (A–T → phases 12–21)

| Module | Name | Target phase | Reuse first |
|---|---|---|---|
| A | Product & services catalogue | 12 | evidence storage, RBAC, audit |
| B | Opportunity matching | 12 | ICP, scoring **pattern**, signals |
| C | Market opportunity radar | 13 | `intent_signals`, discovery, Temporal |
| D | Agentic research | 14 | `ai/`, budgets, quarantine, Temporal |
| E | One-click account intelligence | 14 | research + people + orgmap + export |
| F | Buying committee | 15 | people, relationships, orgmap |
| G | Account strategy / ABM | 15 | accounts, tasks, drafts |
| H | Tender / procurement | 16 | `mock_procurement`, signals |
| P | Competitor intelligence | 16 | signals, evidence |
| I | Proposal studio | 17 | drafts, export, catalogue |
| J | Sales copilot | 18 | all read APIs + RBAC |
| M | Next-best-action | 18 | tasks, scoring eligibility |
| L | Revenue intelligence | 19 | pipeline, tasks (compatible stages) |
| N | Customer expansion | 19 | same CRM entities |
| O | Partnership / channel | 19 | companies + relationships |
| K | Meeting intelligence | 20 | notes/tasks; consent required |
| Q | Voice copilot | 20 | copilot + confirm-before-write |
| R | Monitoring missions | 13–14 (MVP in 13; agents in 14) | Temporal + budgets |
| S | White-label / agency | 21 | tenants/memberships (careful) |
| T | Subscriptions / metering | 21 | budgets, plans, flags; Stripe later |
| — | Hardening | 22 | Phase 6–10 runbooks + load |

---

## 6. Dependency assessment

| Dependency | Blocks | Owner decision needed? |
|---|---|---|
| Phase 11 approval | All of 12+ | **Yes — this gate** |
| Catalogue content (templates) | Match quality in demos | Workspace data; seed fixtures OK |
| Multi-LLM API keys | Live agents (14+) | Yes for production; mocks for CI |
| D12 licensed contacts | Real contact waterfall | Yes |
| Procurement portal terms | Live tenders (16) | Yes (TED/SAM.gov/etc.) |
| Billing provider | Paid plans (21) | Yes before Stripe |
| D13 / Contabo ops | Public URL | Optional; packaging exists |
| Historical win/loss data | Calibrated forecasts (19) | Use heuristics until enough outcomes |
| Consent policy for meetings/voice | Modules K/Q | Legal/product policy |

---

## 7. Phase-wise implementation backlog (12–22)

Each phase: dedicated branch from previous approved merge tip; additive migrations; OpenAPI regen; tests; `PHASE_N_REPORT.md`; no silent story rewrites.

### Phase 12 — Catalogue + matching *(recommended next)*

- Tables: catalogue items/versions, documents, match runs/results.  
- APIs: CRUD catalogue; match company→offerings with factor explanations.  
- UI: Catalogue nav + company match panel.  
- Flags: `product_catalogue`, `opportunity_matching`.  
- Acceptance: match score ≠ ICP score; missing info flagged; no invented pricing.

### Phase 13 — Market Opportunity Radar + mission MVP

- Signal taxonomy extension; opportunity feed; freshness decay; dedupe.  
- Scheduled Temporal mission configs (pause/resume/budget).  
- UI: Opportunity Radar feed.  
- Acceptance: old announcements decay; verified vs inference labelled.

### Phase 14 — AI gateway + agentic account research + one-click report

- AI gateway adapters (mock + optional live).  
- Orchestrator + specialist agents (research, signals, matching, evidence check).  
- One-click “Generate complete account intelligence” with review-before-CRM.  
- Acceptance: unsupported claims quarantined; budgets enforced; traces auditable.

### Phase 15 — Buying committee + account plans

- Stakeholder classifications on people/relationships.  
- Coverage score; versioned account plans; manager assign.  
- Acceptance: no invented reporting lines; no budget-owner without evidence.

### Phase 16 — Tenders + competitors

- Tender entities; mock → optional live adapters; bid/no-bid assist.  
- Competitor watchlists + battlecards with provenance.  
- Acceptance: no auto-submit; no fabricated certifications.

### Phase 17 — Proposal studio

- Templates grounded in catalogue; versioning; approval; DOCX/PDF export path.  
- Acceptance: AI cannot authorize price/discount/warranty alone.

### Phase 18 — Sales copilot + next-best-action

- Conversational assistant over workspace data with citations.  
- NBA recommendations accept/edit/dismiss/defer.  
- Acceptance: RBAC + suppression; no silent CRM writes.

### Phase 19 — Revenue + expansion + partners

- Sales opportunities (compatible with existing pipeline).  
- Weighted pipeline / forecasts as **estimates** until calibrated.  
- Expansion signals; partner records.  
- Acceptance: estimated ≠ realized revenue.

### Phase 20 — Meeting + voice

- Optional upload/transcript; summaries → proposed CRM updates.  
- Voice STT/TTS optional; confirm before consequential actions.  
- Acceptance: consent; no auto stage change.

### Phase 21 — White-label + commercialization readiness

- Agency→client workspace hierarchy; branding hooks.  
- Entitlements + usage ledger; Stripe **stub/disabled** until approved.  
- Acceptance: no cross-client reads; credits independent of single LLM vendor.

### Phase 22 — Hardening

- Full regression; agent eval sets; load/cost; security; backup drill; deploy verification.  
- Acceptance: publish honest capacity report; no overclaim.

---

## 8. Suggested navigation evolution (additive)

Keep current items. Add gradually behind flags:

| New nav | From phase |
|---|---|
| Product catalogue | 12 |
| Opportunity matching | 12 |
| Market Opportunity Radar | 13 |
| Research missions | 13–14 |
| Account intelligence | 14 |
| Account plans | 15 |
| Tenders | 16 |
| Competitors | 16 |
| Proposal studio | 17 |
| AI Sales Copilot | 18 |
| Analytics / forecasting | 19 |
| Partners / expansion | 19 |
| Settings → governance (extend) | continuous |

Do **not** replace Companies / Pipeline / Lists / Discovery / Imports / ICP / Audit / Settings.

---

## 9. Testing strategy for expansion

- Keep all existing suites green.  
- New suites: catalogue permissions, matching explanations, agent failure/retry, mission dedupe, tender extraction fixtures, proposal hallucination checks, NBA accept/dismiss, entitlement enforcement, cross-tenant IDOR for every new entity.  
- Agent eval datasets: factuality, citation correctness, unsupported-claim rate, cost per mission.  
- “Syntactically valid JSON” ≠ accepted intelligence.

---

## 10. Security assessment (Phase 11 scope)

No new attack surface shipped (docs only). Expansion must continue:

- Tenant RLS on every new table with `tenant_id`.  
- No agent tool for unrestricted SQL or outbound send.  
- Metrics/OpenAPI remain gated (Phase 8).  
- Secrets never in repo; providers mocked in CI.

---

## 11. Configuration / deployment notes

- Continue `.env.example` documentation for every new gate.  
- Contabo/VPS guide remains operator-run (`mapforce.aitaskeen.com`); not claimed live.  
- Rollback: forward-only SQL; restore from backup for schema rewind.

---

## 12. Phase 11 acceptance checklist

| Item | Done? |
|---|---|
| Inspected baseline branch `phase-10/release-smoke` | Yes |
| Mapped stack, modules, migrations, flags, adapters, nav | Yes |
| Preservation matrix documented | Yes |
| Conflicts requiring approval listed | Yes |
| Architecture extension plan (additive) | Yes |
| Dependencies assessed | Yes |
| Phase 12–22 backlog defined | Yes |
| No product code / schema / contract changes | Yes |
| Regression sample (lint/typecheck/unit/contracts) | Yes (integration/e2e deferred to pre-12) |
| Owner approval recorded before Phase 12 | **Pending** |

---

## 13. Decision request for product owner

Please approve or amend:

1. **Proceed to Phase 12** (catalogue + matching) on branch `phase-12/catalogue-matching` from this tip after merge/approval.  
2. Confirm **new match scores stay separate** from `icp-explainable/1.0.0`.  
3. Confirm **Temporal-first** agent orchestration (LangGraph only if later justified).  
4. Confirm **D12 / Hermes / Stripe** remain disabled until separate approvals.  
5. Confirm Contabo deploy is **out of scope** for Phase 12 (docs/ops only).

**Reply with:** `APPROVE Phase 11` (+ any amendments) to unlock Phase 12 implementation.

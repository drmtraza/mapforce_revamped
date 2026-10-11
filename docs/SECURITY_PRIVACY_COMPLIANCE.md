# Security, Privacy and Data Acquisition Controls

## 1. Security baseline
- Threat model before production launch; update after major integrations.
- TLS in transit; managed encryption at rest; key rotation.
- Secrets manager in production; no keys in source, logs, prompts or client bundles.
- SSO/OIDC or mature identity provider; MFA for privileged roles.
- RBAC and tenant authorization enforced in services and database policies.
- Secure cookies, CSRF protections where applicable, strict CORS, CSP, HSTS and security headers.
- Validate and normalize every external URL; block loopback, private, link-local and metadata-service IP ranges; defend against DNS rebinding and SSRF.
- Upload/import size limits, MIME validation, malware scanning where appropriate and formula-injection protection on CSV exports.
- Rate limiting, abuse detection, bot protection and per-tenant budgets.
- Audit security-relevant actions, admin access, exports, provider configuration and suppression changes.
- Dependency/SBOM scanning, secret scanning, container scanning and patch policy in CI.
- Backups encrypted and tested through regular restore drills.
- Incident response plan, breach triage and credential revocation runbook.

## 2. Data acquisition policy
- Prefer official APIs, licensed B2B data providers, official public registries, permitted search APIs, public corporate sites and public job/tender portals.
- Review source terms, license, allowed purpose, attribution requirements, retention and redistribution limits before enabling an adapter.
- Do not automate authenticated LinkedIn access or implement CAPTCHA bypass, fingerprint evasion or access-control circumvention.
- Search snippets are leads for research, not definitive current employment evidence.
- Respect robots directives, crawl budgets and per-domain rate limits.
- Keep a source registry with approved use cases and kill switches.
- Provider contracts and jurisdiction-specific advice must be reviewed before commercial launch.

## 3. Privacy controls
- Define a documented business purpose and lawful basis for each data category and target market.
- Minimize fields collected; prefer professional/business information relevant to B2B purpose.
- Avoid sensitive personal data; do not infer it.
- Provide access, correction, deletion and suppression processes appropriate to applicable law.
- Maintain retention schedules and propagate deletions to caches, search indexes, graph projections and exports where feasible.
- Restrict access to contact data; audit bulk exports.
- Avoid personal email/phone collection unless explicitly justified and permitted.
- Do not use data for unrelated purposes without policy and legal review.

## 4. Outreach and suppression
- Initial release produces drafts only; user must review before sending.
- Suppression/unsubscribe status overrides scoring, exports and any later campaign integration.
- Track source, purpose, export actor, time and fields exported.
- Do not design around evading spam filters. Use consent/legitimate-interest assessment and jurisdiction-specific email/marketing rules.
- Set tenant-level export quotas and require confirmation for bulk export.

## 5. Email verification
- MX existence only proves that a domain can receive mail, not that an individual mailbox exists.
- SMTP recipient probing can be blocked, misleading or disallowed by providers. Do not treat it as reliable verification.
- Use an approved email verification provider or mark the result uncertain.
- Never send a message to a guessed address merely to test deliverability.
- Store verification method and timestamp; expire stale results.

## 6. AI data governance
- No cross-tenant prompt/context mixing.
- Redact secrets and minimize PII in model requests.
- Review hosted-model data retention and training terms before use.
- Maintain model/provider configuration, version, cost and evidence IDs.
- Provide human review and correction for material inferred data.
- Prompt injection is treated as a security concern; source text is data, never policy.

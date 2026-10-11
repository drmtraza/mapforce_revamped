import type { Persona } from '@mapforce/contracts';
import type { Tx } from '@mapforce/db';
import { personaFromTitle } from '../ai/taxonomy.ts';
import { isDomainSuppressed } from '../suppressions/check.ts';
import type { IcpForScore, ScoreInput } from './engine.ts';

export async function loadScoreInput(
  trx: Tx,
  tenantId: string,
  companyId: string,
): Promise<ScoreInput | null> {
  const company = await trx
    .selectFrom('companies')
    .select(['id', 'primary_domain', 'industry', 'country_code', 'employee_band', 'description'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!company) return null;

  const people = await trx
    .selectFrom('person_company_links as l')
    .innerJoin('people as p', 'p.id', 'l.person_id')
    .leftJoin('employment_roles as r', (j) =>
      j
        .onRef('r.person_id', '=', 'p.id')
        .onRef('r.company_id', '=', 'l.company_id')
        .on('r.status', '=', 'current'),
    )
    .select(['r.title'])
    .where('l.tenant_id', '=', tenantId)
    .where('l.company_id', '=', companyId)
    .where('p.review_status', '!=', 'rejected')
    .where('p.merged_into_id', 'is', null)
    .limit(200)
    .execute();

  const overlay = await trx
    .selectFrom('ai_runs')
    .select('result')
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .where('status', 'in', ['succeeded', 'quarantined'])
    .where('result', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const overlayPeople = overlay?.result
    ? ((overlay.result as { people?: { persona?: Persona }[] }).people ?? [])
    : [];

  const signals = await trx
    .selectFrom('intent_signals')
    .select(['signal_type', 'implies_budget', 'observed_at'])
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .orderBy('observed_at', 'desc')
    .limit(50)
    .execute();

  const evidence = await trx
    .selectFrom('evidence_records')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .executeTakeFirstOrThrow();
  const sources = await trx
    .selectFrom('evidence_records')
    .select('source_registry_id')
    .distinct()
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .execute();

  return {
    company: {
      id: company.id,
      domain: company.primary_domain,
      industry: company.industry,
      country_code: company.country_code,
      employee_band: company.employee_band,
      description: company.description,
    },
    people: people.map((p, i) => ({
      title: p.title,
      persona: overlayPeople[i]?.persona ?? personaFromTitle(p.title),
    })),
    signals: signals.map((s) => ({
      signal_type: s.signal_type,
      implies_budget: s.implies_budget,
      observed_at: s.observed_at.toISOString(),
    })),
    evidence_count: Number(evidence.n),
    source_count: sources.length,
    suppressed: await isDomainSuppressed(trx, tenantId, company.primary_domain),
  };
}

export function icpFromDefinition(definition: unknown): IcpForScore {
  const d = (definition ?? {}) as Partial<IcpForScore>;
  return {
    industries: d.industries ?? [],
    countries: d.countries ?? [],
    employee_bands: d.employee_bands ?? [],
    target_personas: d.target_personas ?? [],
    signals: d.signals ?? [],
    excluded_domains: d.excluded_domains ?? [],
  };
}

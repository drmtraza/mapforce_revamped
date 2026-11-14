/**
 * Bid / no-bid assist. Heuristic only — never auto-submits a bid.
 */

export interface TenderForBid {
  title: string;
  summary: string;
  category: string;
  country_code: string | null;
  closes_at: Date | null;
}

export interface CatalogueHint {
  name: string;
  category: string;
  target_countries: string[];
}

export interface BidFactor {
  key: string;
  value: number;
  max: number;
  rationale: string;
}

export interface BidAssessment {
  recommendation: 'bid' | 'no_bid' | 'review';
  fit_score: number;
  factors: BidFactor[];
  missing_information: string[];
  note: string;
}

function parseCountries(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function assessBidNoBid(
  tender: TenderForBid,
  offerings: CatalogueHint[],
  now = new Date(),
): BidAssessment {
  const factors: BidFactor[] = [];
  const missing: string[] = [];

  const categoryHit = offerings.some(
    (o) => o.category === tender.category || tender.category === 'other',
  );
  factors.push({
    key: 'catalogue_category',
    value: categoryHit ? 35 : offerings.length ? 10 : 0,
    max: 35,
    rationale: categoryHit
      ? 'Catalogue has overlapping category.'
      : offerings.length
        ? 'Catalogue present but category mismatch.'
        : 'No active catalogue offerings.',
  });
  if (!offerings.length) missing.push('Add at least one active product offering.');

  let geo = 0;
  if (!tender.country_code) {
    missing.push('Tender country_code unknown.');
  } else if (
    offerings.some((o) => {
      const countries = parseCountries(o.target_countries);
      return countries.length === 0 || countries.includes(tender.country_code!);
    })
  ) {
    geo = 25;
  } else {
    geo = 5;
  }
  factors.push({
    key: 'geography',
    value: geo,
    max: 25,
    rationale: `Geography fit for ${tender.country_code ?? 'unknown'}.`,
  });

  let timing = 10;
  if (!tender.closes_at) {
    missing.push('Close date unknown.');
  } else {
    const days = (tender.closes_at.getTime() - now.getTime()) / 86_400_000;
    if (days < 0) timing = 0;
    else if (days < 7) timing = 8;
    else if (days < 21) timing = 15;
    else timing = 20;
  }
  factors.push({
    key: 'timing',
    value: timing,
    max: 20,
    rationale: 'Time remaining before close.',
  });

  const text = `${tender.title} ${tender.summary}`.toLowerCase();
  const keywordHit = offerings.some((o) =>
    text.includes(o.name.toLowerCase().split(/\s+/)[0] ?? ''),
  );
  factors.push({
    key: 'keyword_overlap',
    value: keywordHit ? 20 : 8,
    max: 20,
    rationale: keywordHit
      ? 'Title/summary overlaps catalogue naming.'
      : 'Limited keyword overlap with catalogue.',
  });

  const fit_score = Math.min(
    100,
    factors.reduce((sum, f) => sum + f.value, 0),
  );
  let recommendation: BidAssessment['recommendation'] = 'review';
  if (fit_score >= 70 && missing.length === 0) recommendation = 'bid';
  else if (fit_score < 35) recommendation = 'no_bid';

  return {
    recommendation,
    fit_score,
    factors,
    missing_information: missing,
    note: 'Assistive recommendation only. Humans decide; Mapforce never auto-submits bids or invents certifications.',
  };
}

export { parseCountries };

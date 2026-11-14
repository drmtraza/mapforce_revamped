/** Deterministic mock tender notices — synthetic only. */

export interface MockTenderNotice {
  external_ref: string;
  title: string;
  summary: string;
  buyer_name: string;
  country_code: string;
  category:
    'cybersecurity' | 'cloud' | 'software' | 'professional_services' | 'infrastructure' | 'other';
  published_at: string;
  closes_at: string;
  source_url: string;
}

export function mockTenderNotices(seed: string, now = new Date()): MockTenderNotice[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const day = 86_400_000;
  const base = new Date(now.getTime() - (h % 5) * day);
  return [
    {
      external_ref: `MOCK-TND-${(h % 9000) + 1000}`,
      title: 'Managed SOC and SIEM monitoring services',
      summary:
        'Public tender for 24x7 managed detection and response across cloud workloads. Synthetic fixture.',
      buyer_name: 'Regional Public Agency',
      country_code: h % 2 === 0 ? 'SA' : 'GB',
      category: 'cybersecurity',
      published_at: base.toISOString(),
      closes_at: new Date(base.getTime() + 28 * day).toISOString(),
      source_url: `https://tenders.example.invalid/notices/MOCK-TND-${(h % 9000) + 1000}`,
    },
    {
      external_ref: `MOCK-CLD-${(h % 9000) + 2000}`,
      title: 'Cloud migration advisory framework',
      summary:
        'Framework agreement for cloud architecture advisory. Synthetic fixture — not a live notice.',
      buyer_name: 'Municipal IT Shared Services',
      country_code: 'AE',
      category: 'cloud',
      published_at: new Date(base.getTime() - 3 * day).toISOString(),
      closes_at: new Date(base.getTime() + 14 * day).toISOString(),
      source_url: `https://tenders.example.invalid/notices/MOCK-CLD-${(h % 9000) + 2000}`,
    },
  ];
}

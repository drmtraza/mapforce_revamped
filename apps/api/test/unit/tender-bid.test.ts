import { describe, expect, it } from 'vitest';
import { assessBidNoBid } from '../../src/modules/tenders/bid.ts';
import { mockTenderNotices } from '../../src/modules/tenders/mock.ts';

describe('bid/no-bid assist', () => {
  it('never claims auto-submit and scores catalogue overlap', () => {
    const notices = mockTenderNotices('tenant-a');
    const result = assessBidNoBid(
      {
        title: notices[0]!.title,
        summary: notices[0]!.summary,
        category: notices[0]!.category,
        country_code: notices[0]!.country_code,
        closes_at: new Date(notices[0]!.closes_at),
      },
      [
        {
          name: 'Managed SOC',
          category: 'cybersecurity',
          target_countries: ['SA', 'GB'],
        },
      ],
    );
    expect(result.fit_score).toBeGreaterThan(40);
    expect(result.note).toMatch(/never auto-submits/i);
    expect(['bid', 'no_bid', 'review']).toContain(result.recommendation);
  });

  it('recommends no_bid when catalogue empty and timing poor', () => {
    const result = assessBidNoBid(
      {
        title: 'Unrelated facilities cleaning',
        summary: 'Janitorial services',
        category: 'other',
        country_code: 'XX',
        closes_at: new Date(Date.now() - 86_400_000),
      },
      [],
    );
    expect(result.recommendation).toBe('no_bid');
    expect(result.missing_information.length).toBeGreaterThan(0);
  });
});

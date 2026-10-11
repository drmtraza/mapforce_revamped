import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from '../../src/modules/imports/csv.ts';
import { analyzeCompanyCsv, summarize } from '../../src/modules/imports/service.ts';

const limits = { maxRows: 10, maxColumns: 5, maxCellLength: 20 };

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '\uFEFFa,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\n';
    expect(parseCsv(text, limits)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('skips blank lines and accepts a missing trailing newline', () => {
    expect(parseCsv('a\n\nb', limits)).toEqual([['a'], ['b']]);
  });

  it('keeps formula-looking cells as plain text', () => {
    expect(parseCsv('=1+1,@x', limits)).toEqual([['=1+1', '@x']]);
  });

  it.each([
    ['"open', 'Unterminated quoted cell', 1],
    ['a\nb"c', 'Unexpected quote inside an unquoted cell', 2],
    ['a,b,c,d,e,f', 'Row has more than 5 columns', 1],
    ['x'.repeat(21), 'Cell exceeds 20 characters', 1],
  ])('rejects %j with a line number', (text, message, line) => {
    try {
      parseCsv(text, limits);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CsvError);
      expect((err as CsvError).message).toBe(message);
      expect((err as CsvError).line).toBe(line);
    }
  });

  it('enforces the data row limit (header excluded)', () => {
    const ok = ['h', ...Array.from({ length: 10 }, (_, i) => `r${i}`)].join('\n');
    expect(parseCsv(ok, limits)).toHaveLength(11);
    expect(() => parseCsv(`${ok}\nextra`, limits)).toThrow(CsvError);
  });
});

describe('analyzeCompanyCsv', () => {
  it('normalizes rows and classifies invalid and duplicate rows', () => {
    const csv = [
      'Domain,Name,country_code,industry,notes',
      'https://www.Acme.example/about,Acme,gb,Logistics,ignored',
      'acme.example,Acme again,,,',
      ',No domain,,,',
      'not a domain,Bad,,,',
      'beta.example,Beta,GBR,,',
      `gamma.example,${'n'.repeat(301)},,,`,
      `delta.example,Delta,,${'i'.repeat(121)},`,
    ].join('\n');
    const { rows, ignored } = analyzeCompanyCsv(csv);
    expect(ignored).toEqual(['notes']);
    expect(rows.map((r) => [r.row_number, r.outcome, r.error_code])).toEqual([
      [1, 'created', null],
      [2, 'duplicate_in_file', null],
      [3, 'invalid', 'MISSING_DOMAIN'],
      [4, 'invalid', 'INVALID_DOMAIN'],
      [5, 'invalid', 'INVALID_COUNTRY'],
      [6, 'invalid', 'NAME_TOO_LONG'],
      [7, 'invalid', 'INDUSTRY_TOO_LONG'],
    ]);
    expect(rows[0]).toMatchObject({
      normalized_domain: 'acme.example',
      name: 'Acme',
      country_code: 'GB',
      industry: 'Logistics',
    });
    expect(summarize(rows)).toEqual({
      rows: 7,
      created: 1,
      existing: 0,
      duplicate_in_file: 1,
      invalid: 5,
    });
  });

  it.each([
    ['', 'CSV is empty.'],
    ['name\nAcme', 'CSV header must include a "domain" column.'],
    ['domain\n', 'CSV has no data rows.'],
    ['domain\n"open', 'CSV could not be parsed: Unterminated quoted cell.'],
  ])('rejects %j', (csv, message) => {
    expect(() => analyzeCompanyCsv(csv)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', message }),
    );
  });
});

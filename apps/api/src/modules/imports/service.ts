import { normalizeDomain } from '../../domain.ts';
import { AppError } from '../../errors.ts';
import type { ImportOutcome } from '@mapforce/db';
import { CsvError, parseCsv } from './csv.ts';

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_BYTES = 1024 * 1024;
const KNOWN_COLUMNS = ['domain', 'name', 'country_code', 'industry'] as const;
type Column = (typeof KNOWN_COLUMNS)[number];

export interface AnalyzedRow {
  row_number: number;
  raw: Partial<Record<Column, string>>;
  normalized_domain: string | null;
  outcome: ImportOutcome;
  error_code: string | null;
  error_message: string | null;
  company_id: string | null;
  name: string | null;
  country_code: string | null;
  industry: string | null;
}

/**
 * Parses and validates a company CSV. Required header: `domain`; optional: `name`,
 * `country_code`, `industry`. Unknown columns are ignored. Outcomes other than
 * `invalid`/`duplicate_in_file` are provisional until existing companies are checked.
 */
export function analyzeCompanyCsv(text: string): { rows: AnalyzedRow[]; ignored: string[] } {
  let table: string[][];
  try {
    table = parseCsv(text, { maxRows: IMPORT_MAX_ROWS, maxColumns: 50, maxCellLength: 2000 });
  } catch (err) {
    if (err instanceof CsvError) {
      throw new AppError('VALIDATION_ERROR', `CSV could not be parsed: ${err.message}.`, [
        { line: err.line },
      ]);
    }
    throw err;
  }
  const [header, ...body] = table;
  if (!header) throw new AppError('VALIDATION_ERROR', 'CSV is empty.');
  const names = header.map((h) => h.trim().toLowerCase());
  const index = new Map<Column, number>();
  KNOWN_COLUMNS.forEach((c) => {
    const at = names.indexOf(c);
    if (at >= 0) index.set(c, at);
  });
  if (!index.has('domain')) {
    throw new AppError('VALIDATION_ERROR', 'CSV header must include a "domain" column.');
  }
  if (body.length === 0) throw new AppError('VALIDATION_ERROR', 'CSV has no data rows.');

  const seen = new Set<string>();
  const rows = body.map((cells, i): AnalyzedRow => {
    const raw: Partial<Record<Column, string>> = {};
    for (const [col, at] of index) {
      const value = cells[at]?.trim();
      if (value) raw[col] = value;
    }
    const base = {
      row_number: i + 1,
      raw,
      normalized_domain: null,
      company_id: null,
      name: raw.name ?? null,
      country_code: null as string | null,
      industry: raw.industry ?? null,
    };
    const invalid = (code: string, message: string): AnalyzedRow => ({
      ...base,
      outcome: 'invalid',
      error_code: code,
      error_message: message,
    });

    if (!raw.domain) return invalid('MISSING_DOMAIN', 'Domain is required.');
    let domain: string;
    try {
      domain = normalizeDomain(raw.domain);
    } catch (err) {
      return invalid('INVALID_DOMAIN', err instanceof AppError ? err.message : 'Invalid domain.');
    }
    if (raw.name && raw.name.length > 300) {
      return invalid('NAME_TOO_LONG', 'Name must be 300 characters or fewer.');
    }
    if (raw.industry && raw.industry.length > 120) {
      return invalid('INDUSTRY_TOO_LONG', 'Industry must be 120 characters or fewer.');
    }
    let country: string | null = null;
    if (raw.country_code) {
      country = raw.country_code.toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) {
        return invalid('INVALID_COUNTRY', 'Country code must be ISO 3166-1 alpha-2, e.g. GB.');
      }
    }
    if (seen.has(domain)) {
      return {
        ...base,
        normalized_domain: domain,
        country_code: country,
        outcome: 'duplicate_in_file',
        error_code: null,
        error_message: 'Same domain appears earlier in the file.',
      };
    }
    seen.add(domain);
    return {
      ...base,
      normalized_domain: domain,
      country_code: country,
      outcome: 'created',
      error_code: null,
      error_message: null,
    };
  });
  const ignored = names.filter((n) => n && !(KNOWN_COLUMNS as readonly string[]).includes(n));
  return { rows, ignored };
}

export function summarize(rows: AnalyzedRow[]) {
  const count = (o: ImportOutcome) => rows.filter((r) => r.outcome === o).length;
  return {
    rows: rows.length,
    created: count('created'),
    existing: count('existing'),
    duplicate_in_file: count('duplicate_in_file'),
    invalid: count('invalid'),
  };
}

/** Minimal RFC 4180 parser with hard limits; no type coercion or formula evaluation. */

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
}

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

export function parseCsv(input: string, limits: CsvLimits): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let i = 0;

  const pushCell = () => {
    if (cell.length > limits.maxCellLength) {
      throw new CsvError(`Cell exceeds ${limits.maxCellLength} characters`, line);
    }
    row.push(cell);
    if (row.length > limits.maxColumns) {
      throw new CsvError(`Row has more than ${limits.maxColumns} columns`, line);
    }
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > limits.maxRows + 1) {
        throw new CsvError(`File has more than ${limits.maxRows} data rows`, line);
      }
    }
    row = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cell.length > 0) throw new CsvError('Unexpected quote inside an unquoted cell', line);
      quoted = true;
    } else if (ch === ',') {
      pushCell();
    } else if (ch === '\r' || ch === '\n') {
      pushRow();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (quoted) throw new CsvError('Unterminated quoted cell', line);
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

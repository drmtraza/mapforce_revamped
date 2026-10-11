/** Prefix formula-like cells so spreadsheet apps do not execute them. */
export function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const dangerous = /^[=+\-@\t\r]/.test(raw);
  const escaped = (dangerous ? `'${raw}` : raw).replace(/"/g, '""');
  return `"${escaped}"`;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvCell).join(',');
}

export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  return [csvRow(headers), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

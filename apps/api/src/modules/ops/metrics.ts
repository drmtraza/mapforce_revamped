/** In-process counters. No tenant labels — scrape this only on a private network. */

const buckets = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

export interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

function emptyHistogram(): Histogram {
  return { count: 0, sum: 0, buckets: buckets.map(() => 0) };
}

const requests = new Map<string, { count: number; errors: number; latency: Histogram }>();
let rateLimited = 0;
let startedAt = Date.now();

function series(method: string, route: string) {
  const key = `${method} ${route}`;
  let row = requests.get(key);
  if (!row) {
    row = { count: 0, errors: 0, latency: emptyHistogram() };
    requests.set(key, row);
  }
  return row;
}

export function observeRequest(method: string, route: string, statusCode: number, ms: number) {
  const row = series(method, route);
  row.count += 1;
  if (statusCode >= 500) row.errors += 1;
  if (statusCode === 429) rateLimited += 1;
  row.latency.count += 1;
  row.latency.sum += ms;
  for (let i = 0; i < buckets.length; i += 1) {
    if (ms <= buckets[i]!) row.latency.buckets[i]! += 1;
  }
}

export function resetMetrics() {
  requests.clear();
  rateLimited = 0;
  startedAt = Date.now();
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function snapshot() {
  const routes = [...requests.entries()].map(([route, row]) => ({
    route,
    count: row.count,
    errors: row.errors,
    latency_ms_avg: row.latency.count === 0 ? 0 : Math.round(row.latency.sum / row.latency.count),
  }));
  return {
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    rate_limited: rateLimited,
    requests: routes,
  };
}

export function prometheusText(extra: Record<string, number> = {}): string {
  const lines = [
    '# HELP mapforce_up 1 if the process is serving requests.',
    '# TYPE mapforce_up gauge',
    'mapforce_up 1',
    '# HELP mapforce_rate_limited_total HTTP 429 responses.',
    '# TYPE mapforce_rate_limited_total counter',
    `mapforce_rate_limited_total ${rateLimited}`,
  ];
  for (const [name, value] of Object.entries(extra)) {
    const safe = name.replace(/[^a-z0-9_]/gi, '_');
    lines.push(`# TYPE ${safe} gauge`, `${safe} ${value}`);
  }
  lines.push(
    '# HELP mapforce_http_requests_total HTTP requests by route and method.',
    '# TYPE mapforce_http_requests_total counter',
  );
  for (const [route, row] of requests) {
    const [method, path] = route.split(' ');
    const labels = `method="${method}",route="${path}"`;
    lines.push(`mapforce_http_requests_total{${labels}} ${row.count}`);
    lines.push(`mapforce_http_errors_total{${labels}} ${row.errors}`);
    lines.push(`mapforce_http_request_duration_ms_sum{${labels}} ${row.latency.sum}`);
    lines.push(`mapforce_http_request_duration_ms_count{${labels}} ${row.latency.count}`);
    row.latency.buckets.forEach((n, i) => {
      lines.push(`mapforce_http_request_duration_ms_bucket{${labels},le="${buckets[i]}"} ${n}`);
    });
    lines.push(
      `mapforce_http_request_duration_ms_bucket{${labels},le="+Inf"} ${row.latency.count}`,
    );
  }
  return lines.join('\n') + '\n';
}

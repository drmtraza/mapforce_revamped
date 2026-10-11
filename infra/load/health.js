import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * Public health baseline. Does not exercise authenticated tenant APIs.
 * This is not a 10K-user proof. Raise VUs only after reviewing host budget.
 *
 *   k6 run infra/load/health.js
 *   k6 run -e BASE_URL=http://localhost:4000 --vus 20 --duration 1m infra/load/health.js
 */
export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:4000';

export default function () {
  const health = http.get(`${BASE}/healthz`);
  check(health, { 'healthz 200': (r) => r.status === 200 });
  const ready = http.get(`${BASE}/readyz`);
  check(ready, { 'readyz 200': (r) => r.status === 200 });
  sleep(0.2);
}

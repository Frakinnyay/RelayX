// Experiment: ingestion throughput and latency at a fixed arrival rate.
// Run: k6 run -e RATE=200 -e DURATION=60s load-tests/ingest.js
import http from 'k6/http';
import { check } from 'k6';
import { API, headers, pickEndpointId } from './common.js';

const RATE = Number(__ENV.RATE || 100);
export const options = {
  scenarios: {
    ingest: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: __ENV.DURATION || '30s', preAllocatedVUs: 50, maxVUs: 500 },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

export function setup() {
  return { endpointId: pickEndpointId(http) };
}

export default function (data) {
  const res = http.post(
    `${API}/api/v1/events`,
    JSON.stringify({ eventType: 'load.test', endpointId: data.endpointId, payload: { n: __ITER, vu: __VU }, idempotencyKey: `${__ENV.RUN_ID || 'run'}-${__VU}-${__ITER}-${Date.now()}` }),
    { headers },
  );
  check(res, { 'accepted (202)': (r) => r.status === 202 });
}

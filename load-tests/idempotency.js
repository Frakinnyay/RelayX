// Experiment: many clients send the SAME idempotency key at once. Exactly one event may be created.
// Run: k6 run load-tests/idempotency.js ; expect ~1 check pass for "new event (202)" and ~499 for "replayed original (200)". Then verify with the SQL in docs/PERFORMANCE_TESTING.md
import http from 'k6/http';
import { check } from 'k6';
import { API, headers, pickEndpointId } from './common.js';

export const options = { vus: 50, iterations: 500 };

// The key is generated in setup() (runs once) and passed to every VU. Do NOT generate it at the top level of the
// script: k6 evaluates that code once per VU, which would give each VU a different key.
export function setup() {
  const key = `idem-${Date.now()}`;
  console.log(`idempotency key used: ${key}`);
  return { endpointId: pickEndpointId(http), key };
}
export default function (data) {
  const res = http.post(`${API}/api/v1/events`, JSON.stringify({ eventType: 'idem.test', endpointId: data.endpointId, payload: { same: true }, idempotencyKey: data.key }), { headers });
  check(res, { 'new event (202)': (r) => r.status === 202, 'replayed original (200)': (r) => r.status === 200 });
}

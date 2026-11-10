// Experiment: end-to-end worker throughput. Sends N events, then waits until all are delivered and prints events/second.
// Run: k6 run -e N=2000 load-tests/delivery-throughput.js
// Make sure the receiver is HEALTHY and the tenant rate limit is high (see docs/PERFORMANCE_TESTING.md).
import http from 'k6/http';
import { sleep } from 'k6';
import { API, headers, pickEndpointId } from './common.js';

const N = Number(__ENV.N || 1000);
export const options = { vus: 1, iterations: 1, setupTimeout: '600s', teardownTimeout: '600s', thresholds: {} };

const successCount = () => http.get(`${API}/api/v1/stats`, { headers }).json('deliveries.SUCCESS');

export function setup() {
  const endpointId = pickEndpointId(http);
  const before = successCount();
  const t0 = Date.now();
  for (let i = 0; i < N; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(i + 50, N); j++) {
      batch.push(['POST', `${API}/api/v1/events`, JSON.stringify({ eventType: 'throughput.test', endpointId, payload: { j }, idempotencyKey: `tp-${t0}-${j}` }), { headers }]);
    }
    http.batch(batch);
  }
  return { before, t0, ingestMs: Date.now() - t0 };
}
export default function () {}
export function teardown(d) {
  const target = d.before + N;
  const start = Date.now();
  let done = successCount();
  while (done < target && Date.now() - start < 540000) { sleep(1); done = successCount(); }
  const totalSec = (Date.now() - d.t0) / 1000;
  console.log(`delivered ${done - d.before}/${N} events; ingest took ${(d.ingestMs / 1000).toFixed(1)}s; total ${totalSec.toFixed(1)}s => ${((done - d.before) / totalSec).toFixed(1)} deliveries/s end-to-end`);
}

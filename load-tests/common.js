export const API = __ENV.API_URL || 'http://localhost:3000';
export const KEY = __ENV.API_KEY || 'rx_demo_local_key_0123456789abcdef';
export const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Picks the endpoint to load-test. Set -e ENDPOINT_ID=<uuid> to choose explicitly; otherwise the first ACTIVE
// endpoint whose URL ends in /webhook (the receiver simulator). Never blindly "the first in the list":
// the API lists newest first, which may be a deliberately broken endpoint created during a demo.
export function pickEndpointId(http) {
  if (__ENV.ENDPOINT_ID) return __ENV.ENDPOINT_ID;
  const r = http.get(`${API}/api/v1/endpoints`, { headers });
  if (r.status !== 200) throw new Error(`Cannot list endpoints (status ${r.status}). Check API_URL / API_KEY.`);
  const eps = r.json('data').filter((e) => e.active && /\/webhook$/.test(e.url));
  if (!eps.length) throw new Error('No active endpoint whose URL ends with /webhook. Pass -e ENDPOINT_ID=<id>.');
  return eps[0].id;
}

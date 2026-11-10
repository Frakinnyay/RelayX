export type AttemptOutcome = 'SUCCESS' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';

/**
 * 2xx            -> success
 * 408, 429, 5xx  -> retry (receiver is slow, throttling us, or broken)
 * everything else (other 4xx, 3xx, 1xx) -> permanent: retrying the same request cannot help.
 * Redirects are NOT followed (following them would be an SSRF vector).
 */
export function classifyStatus(code: number): AttemptOutcome {
  if (code >= 200 && code < 300) return 'SUCCESS';
  if (code === 408 || code === 429 || code >= 500) return 'RETRYABLE_FAILURE';
  return 'PERMANENT_FAILURE';
}

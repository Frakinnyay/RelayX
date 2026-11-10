import http from 'node:http';
import https from 'node:https';
import { createGuardedLookup, validateWebhookUrl } from '../domain/ssrf';

export interface SendRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  allowPrivate: boolean;
  signal?: AbortSignal;
}

export interface SendResult {
  statusCode: number | null;
  error: string | null;
  retryAfterHeader: string | undefined;
  blocked: boolean;
  aborted: boolean;
}

export type Sender = (req: SendRequest) => Promise<SendResult>;

/**
 * One POST, no redirects, hard total timeout, DNS results validated against private ranges.
 * Resolves (never rejects): network problems are returned as `error`.
 * The response body is discarded; we only need the status code.
 */
export const sendWebhook: Sender = (req) =>
  new Promise<SendResult>((resolve) => {
    const check = validateWebhookUrl(req.url, req.allowPrivate);
    if (!check.ok) {
      resolve({ statusCode: null, error: `BLOCKED_URL: ${check.reason}`, retryAfterHeader: undefined, blocked: true, aborted: false });
      return;
    }
    const url = check.url;
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let aborted = false;
    const finish = (r: SendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    const request = transport.request(
      url,
      {
        method: 'POST',
        headers: { ...req.headers, 'Content-Length': String(Buffer.byteLength(req.body)) },
        lookup: createGuardedLookup(req.allowPrivate),
        agent: false,
      },
      (res) => {
        const ra = res.headers['retry-after'];
        finish({ statusCode: res.statusCode ?? null, error: null, retryAfterHeader: Array.isArray(ra) ? ra[0] : ra, blocked: false, aborted: false });
        res.resume();
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('TIMEOUT')), req.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      request.destroy(new Error('ABORTED'));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) onAbort();

    request.on('error', (err: NodeJS.ErrnoException) => {
      const blocked = err.code === 'EBLOCKED';
      const text = err.message === 'TIMEOUT' ? 'TIMEOUT' : `${err.code ?? 'NETWORK_ERROR'}: ${err.message}`.slice(0, 300);
      finish({ statusCode: null, error: text, retryAfterHeader: undefined, blocked, aborted });
    });
    request.end(req.body);
  });

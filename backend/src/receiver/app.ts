import cors from 'cors';
import express, { type Express } from 'express';
import { verifySignature } from '../domain/signature';

export interface ReceiverOptions {
  secret: string;
  hangMs: number;
  now?: () => number;
}

interface LogEntry {
  at: string;
  eventId: string;
  eventType: string;
  attempt: number;
  signatureValid: boolean;
  responded: string;
  duplicate: boolean;
}

const FAILURE_SEQUENCE = ['500', 'timeout', '500', '503'] as const;

/**
 * Simulated customer webhook receiver. Healthy: verifies the signature, returns 200 and de-duplicates by event id.
 * Failing (for N seconds): cycles through 500 -> timeout -> 500 -> 503 so the retry behaviour is easy to see.
 */
export function createReceiverApp(opts: ReceiverOptions): Express {
  const now = opts.now ?? Date.now;
  const app = express();
  app.use(cors());

  let failUntil = 0;
  let failureCounter = 0;
  const processed = new Set<string>();
  const log: LogEntry[] = [];
  const stats = { received: 0, succeeded: 0, failed: 0, duplicates: 0, badSignatures: 0 };

  const remainingSeconds = (): number => Math.max(0, Math.ceil((failUntil - now()) / 1000));

  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const signatureValid = verifySignature({
      secret: opts.secret,
      timestampHeader: req.header('x-relayx-timestamp'),
      signatureHeader: req.header('x-relayx-signature'),
      rawBody: raw,
    }).valid;
    const eventId = req.header('x-relayx-event-id') ?? 'unknown';
    const entry: LogEntry = {
      at: new Date(now()).toISOString(),
      eventId,
      eventType: req.header('x-relayx-event-type') ?? 'unknown',
      attempt: Number(req.header('x-relayx-attempt') ?? 0),
      signatureValid,
      responded: '',
      duplicate: false,
    };
    stats.received += 1;
    const record = (responded: string): void => {
      entry.responded = responded;
      log.unshift(entry);
      if (log.length > 100) log.pop();
    };

    if (remainingSeconds() > 0) {
      stats.failed += 1;
      const mode = FAILURE_SEQUENCE[failureCounter++ % FAILURE_SEQUENCE.length];
      if (mode === 'timeout') {
        record('timeout (no response)');
        setTimeout(() => {
          if (!res.writableEnded) res.status(504).end();
        }, opts.hangMs);
        return;
      }
      record(mode);
      res.status(Number(mode)).json({ error: 'simulated failure' });
      return;
    }
    if (!signatureValid) {
      stats.badSignatures += 1;
      stats.failed += 1;
      record('401 (bad signature)');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    if (processed.has(eventId)) {
      stats.duplicates += 1;
      entry.duplicate = true;
    } else {
      processed.add(eventId);
    }
    stats.succeeded += 1;
    record('200');
    res.status(200).json({ ok: true });
  });

  app.use(express.json());
  app.get('/health', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/control/state', (_req, res) => {
    const remaining = remainingSeconds();
    res.json({ status: remaining > 0 ? 'failing' : 'healthy', remainingSeconds: remaining, stats, uniqueEventsProcessed: processed.size, recent: log.slice(0, 30) });
  });
  app.post('/control/fail', (req, res) => {
    const seconds = Number((req.body as { seconds?: unknown })?.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
      res.status(400).json({ error: 'seconds must be between 1 and 3600' });
      return;
    }
    failUntil = now() + seconds * 1000;
    failureCounter = 0;
    res.json({ status: 'failing', remainingSeconds: remainingSeconds() });
  });
  app.post('/control/heal', (_req, res) => {
    failUntil = 0;
    res.json({ status: 'healthy' });
  });
  app.post('/control/reset', (_req, res) => {
    failUntil = 0;
    processed.clear();
    log.length = 0;
    Object.assign(stats, { received: 0, succeeded: 0, failed: 0, duplicates: 0, badSignatures: 0 });
    res.json({ status: 'reset' });
  });
  return app;
}

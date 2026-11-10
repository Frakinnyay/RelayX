import { useState } from 'react';
import { receiver } from '../api';
import { usePolling } from '../hooks';
import { ErrorLine, fmtTime } from './common';

export function Receiver() {
  const { data, error, reload } = usePolling(receiver.state, 1000);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); reload(); }
  };

  return (
    <div className="card">
      <h2>
        Receiver simulator{' '}
        {data && <span className={`badge ${data.status}`}>{data.status === 'healthy' ? 'HEALTHY' : `FAILING – ${data.remainingSeconds}s left`}</span>}
      </h2>
      <div className="row">
        <button className="btn red" disabled={busy} onClick={() => void act(() => receiver.fail(30))}>Fail 30 s</button>
        <button className="btn red" disabled={busy} onClick={() => void act(() => receiver.fail(120))}>Fail 2 min</button>
        <button className="btn green" disabled={busy} onClick={() => void act(receiver.heal)}>Heal now</button>
        <button className="btn gray" disabled={busy} onClick={() => void act(receiver.reset)}>Reset log</button>
      </div>
      <ErrorLine error={error ? `Receiver not reachable (${error}). Is it running on the URL in VITE_RECEIVER_URL?` : undefined} />
      {data && (
        <>
          <p className="muted">
            received {data.stats.received} · ok {data.stats.succeeded} · failed {data.stats.failed} · unique events processed {data.uniqueEventsProcessed} ·{' '}
            <span className={data.stats.duplicates ? 'dup' : ''}>duplicate deliveries {data.stats.duplicates}</span> · bad signatures {data.stats.badSignatures}
          </p>
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Attempt</th><th>Signature</th><th>Receiver answered</th></tr></thead>
            <tbody>
              {data.recent.slice(0, 10).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{fmtTime(r.at)}</td>
                  <td>{r.eventId.slice(0, 8)}</td>
                  <td>{r.attempt}</td>
                  <td>{r.signatureValid ? 'valid' : 'INVALID'}</td>
                  <td>{r.responded}{r.duplicate && <span className="dup"> (duplicate – already processed)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import type { RelayXClient } from '../api';
import { usePolling } from '../hooks';
import { ErrorLine, fmtTime } from './common';

export function DeadLetters({ client }: { client: RelayXClient }) {
  const { data, error, reload } = usePolling(() => client.deliveries('DEAD_LETTERED'), 2000);
  const [msg, setMsg] = useState<string>();
  return (
    <div className="card">
      <h2>Dead-letter queue</h2>
      <p className="muted">Deliveries that failed permanently or ran out of attempts. Replay creates a new delivery; this history stays untouched.</p>
      {msg && <p className="muted">{msg}</p>}
      <table>
        <thead><tr><th>Failed at</th><th>Event</th><th>Type</th><th>Attempts</th><th>Last HTTP</th><th>Reason</th><th /></tr></thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id}>
              <td>{fmtTime(d.completedAt)}</td><td>{d.eventId.slice(0, 8)}</td><td>{d.eventType}</td><td>{d.attemptCount}/{d.maxAttempts}</td>
              <td>{d.lastStatusCode ?? '—'}</td><td>{d.lastError}</td>
              <td><button className="btn" onClick={() => void client.replay(d.id).then(() => { setMsg('Replay queued.'); reload(); }).catch((e: unknown) => setMsg(String(e)))}>Replay</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p className="muted">Nothing here – nothing has been dead-lettered.</p>}
      <ErrorLine error={error} />
    </div>
  );
}

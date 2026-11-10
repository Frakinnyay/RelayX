import { useState } from 'react';
import type { RelayXClient } from '../api';
import { usePolling, useNow } from '../hooks';
import { Badge, ErrorLine, countdown, fmtTime } from './common';

export function EventDetailView({ client, eventId, onClose }: { client: RelayXClient; eventId: string; onClose: () => void }) {
  const { data, error, reload } = usePolling(() => client.event(eventId), 1500, [eventId]);
  const now = useNow();
  const [msg, setMsg] = useState<string>();

  const replay = async (deliveryId: string) => {
    try { await client.replay(deliveryId); setMsg('Replay queued – a NEW delivery was created.'); reload(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="card">
      <div className="row"><h2 style={{ flex: 1 }}>Event {eventId.slice(0, 8)} – delivery timeline</h2><button className="btn gray" onClick={onClose}>Close</button></div>
      <ErrorLine error={error} />
      {msg && <p className="muted">{msg}</p>}
      {data && (
        <>
          <p className="muted">{data.eventType} · idempotency key: {data.idempotencyKey ?? 'none'} · id {data.id}</p>
          <pre>{JSON.stringify(data.payload, null, 2)}</pre>
          {data.deliveries.map((d) => (
            <div key={d.id} style={{ marginBottom: 16 }}>
              <div className="row">
                <Badge status={d.status} />
                <span className="muted">delivery {d.id.slice(0, 8)}{d.replayOf ? ` (replay of ${d.replayOf.slice(0, 8)})` : ''} · attempts {d.attemptCount}/{d.maxAttempts}</span>
                {(d.status === 'RETRY_WAITING' || d.status === 'PENDING') && <span>next attempt {countdown(d.nextAttemptAt, now)}</span>}
                {(d.status === 'DEAD_LETTERED' || d.status === 'SUCCESS') && <button className="btn" onClick={() => void replay(d.id)}>Replay</button>}
              </div>
              <div className="timeline">
                {d.attempts.map((a) => (
                  <div className="item" key={a.id}>
                    <b>Attempt {a.attemptNumber}</b> at {fmtTime(a.startedAt)} → <b>{a.statusCode ?? a.error ?? 'no response'}</b>{' '}
                    <span className="muted">({a.outcome}, {a.durationMs} ms, worker {a.workerId.slice(-8)})</span>
                  </div>
                ))}
                {d.status === 'RETRY_WAITING' && <div className="item muted">⏳ waiting for retry – last error: {d.lastError}</div>}
                {d.status === 'DEAD_LETTERED' && <div className="item err">☠ dead-lettered – {d.lastError}</div>}
                {d.status === 'SUCCESS' && <div className="item">✅ delivered</div>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function Events({ client }: { client: RelayXClient }) {
  const { data, error } = usePolling(() => client.events(100), 2000);
  const [selected, setSelected] = useState<string>();
  return (
    <>
      <div className="card">
        <h2>Events</h2>
        <table>
          <thead><tr><th>Created</th><th>Id</th><th>Type</th><th>Status</th><th>Attempts</th><th>Last HTTP</th></tr></thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id} className="click" onClick={() => setSelected(e.id)}>
                <td>{fmtTime(e.createdAt)}</td><td>{e.id.slice(0, 8)}</td><td>{e.eventType}</td>
                <td><Badge status={e.status} /></td><td>{e.attemptCount}/{e.maxAttempts}</td><td>{e.lastStatusCode ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorLine error={error} />
      </div>
      {selected && <EventDetailView client={client} eventId={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}

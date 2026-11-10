import { useState } from 'react';
import type { RelayXClient } from '../api';
import { usePolling, useNow } from '../hooks';
import { Badge, ErrorLine, countdown, fmtTime } from './common';
import { EventDetailView } from './Events';
import { Receiver } from './Receiver';

const STATUSES = ['PENDING', 'PROCESSING', 'RETRY_WAITING', 'SUCCESS', 'DEAD_LETTERED'] as const;

export function Dashboard({ client }: { client: RelayXClient }) {
  const stats = usePolling(() => client.stats(), 1500);
  const events = usePolling(() => client.events(15), 1500);
  const endpoints = usePolling(() => client.endpoints(), 10000);
  const [endpointId, setEndpointId] = useState('');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const now = useNow();

  const active = endpoints.data?.filter((e) => e.active) ?? [];
  const target = endpointId || active[0]?.id || '';

  const send = async (n: number) => {
    try {
      for (let i = 0; i < n; i++) await client.sendEvent(target, 'order.created', { orderId: crypto.randomUUID().slice(0, 8), amount: 1499 });
      setError(undefined);
      events.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="card">
        <h2>Delivery status</h2>
        <div className="grid">
          <div className="stat"><b>{stats.data?.events ?? '–'}</b>events</div>
          {STATUSES.map((s) => (
            <div className="stat" key={s}><b>{stats.data?.deliveries[s] ?? '–'}</b><Badge status={s} /></div>
          ))}
        </div>
        <ErrorLine error={stats.error} />
      </div>

      <Receiver />

      <div className="card">
        <h2>Send test events</h2>
        <div className="row">
          <select value={target} onChange={(e) => setEndpointId(e.target.value)}>
            {active.map((e) => <option key={e.id} value={e.id}>{e.description ?? e.url}</option>)}
          </select>
          <button className="btn" disabled={!target} onClick={() => void send(1)}>Send 1 event</button>
          <button className="btn" disabled={!target} onClick={() => void send(5)}>Send 5 events</button>
        </div>
        {!active.length && <p className="muted">No active endpoint yet – add one in the Endpoints tab.</p>}
        <ErrorLine error={error} />
      </div>

      <div className="card">
        <h2>Recent events (click for the delivery timeline)</h2>
        <table>
          <thead><tr><th>Created</th><th>Type</th><th>Status</th><th>Attempts</th><th>Last HTTP</th><th>Next retry</th></tr></thead>
          <tbody>
            {events.data?.map((e) => (
              <tr key={e.id} className="click" onClick={() => setSelected(e.id)}>
                <td>{fmtTime(e.createdAt)}</td>
                <td>{e.eventType}</td>
                <td><Badge status={e.status} /></td>
                <td>{e.attemptCount}/{e.maxAttempts}</td>
                <td>{e.lastStatusCode ?? '—'}</td>
                <td>{e.status === 'RETRY_WAITING' || e.status === 'PENDING' ? countdown(e.nextAttemptAt, now) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorLine error={events.error} />
      </div>
      {selected && <EventDetailView client={client} eventId={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}

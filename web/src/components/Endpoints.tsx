import { useState } from 'react';
import type { RelayXClient } from '../api';
import { usePolling } from '../hooks';
import { ErrorLine } from './common';

export function Endpoints({ client }: { client: RelayXClient }) {
  const { data, error, reload } = usePolling(() => client.endpoints(), 3000);
  const [url, setUrl] = useState('http://receiver:4000/webhook');
  const [description, setDescription] = useState('');
  const [secret, setSecret] = useState('whsec_demo_local_secret');
  const [created, setCreated] = useState<string>();
  const [formError, setFormError] = useState<string>();

  const add = async () => {
    try {
      const ep = await client.createEndpoint({ url, description: description || undefined, secret: secret || undefined });
      setCreated(ep.secret);
      setFormError(undefined);
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="card">
        <h2>Add endpoint</h2>
        <div className="row">
          <input className="wide" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="description" />
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="secret (blank = generate)" />
          <button className="btn" onClick={() => void add()}>Create</button>
        </div>
        <p className="muted">Docker demo receiver: http://receiver:4000/webhook with secret whsec_demo_local_secret. Running everything outside Docker: http://localhost:4000/webhook.</p>
        {created && <p>Signing secret (shown once): <code>{created}</code></p>}
        <ErrorLine error={formError} />
      </div>
      <div className="card">
        <h2>Endpoints</h2>
        <table>
          <thead><tr><th>Id</th><th>URL</th><th>Description</th><th>Active</th><th /></tr></thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id}>
                <td>{e.id.slice(0, 8)}</td><td>{e.url}</td><td>{e.description}</td><td>{e.active ? 'yes' : 'no'}</td>
                <td>{e.active && <button className="btn gray" onClick={() => void client.deactivateEndpoint(e.id).then(reload)}>Deactivate</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorLine error={error} />
      </div>
    </>
  );
}

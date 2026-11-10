import { useMemo, useState } from 'react';
import { RelayXClient } from './api';
import { Dashboard } from './components/Dashboard';
import { DeadLetters } from './components/DeadLetters';
import { Endpoints } from './components/Endpoints';
import { Events } from './components/Events';

type Tab = 'dashboard' | 'events' | 'endpoints' | 'dead';

const KEY_STORAGE = 'relayx_api_key';

export function App() {
  const [apiKey, setApiKey] = useState<string>(sessionStorage.getItem(KEY_STORAGE) ?? '');
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<Tab>('dashboard');
  const client = useMemo(() => (apiKey ? new RelayXClient(apiKey) : null), [apiKey]);

  if (!client) {
    return (
      <main>
        <div className="card">
          <h2>RelayX – sign in with your API key</h2>
          <p className="muted">
            Local demo key: <code>rx_demo_local_key_0123456789abcdef</code>. The key is kept in this browser tab only (sessionStorage).
          </p>
          <div className="row">
            <input className="wide" type="password" placeholder="rx_..." value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button
              className="btn"
              disabled={!draft.trim()}
              onClick={() => {
                sessionStorage.setItem(KEY_STORAGE, draft.trim());
                setApiKey(draft.trim());
              }}
            >
              Sign in
            </button>
          </div>
        </div>
      </main>
    );
  }

  const tabs: [Tab, string][] = [['dashboard', 'Dashboard & Chaos Demo'], ['events', 'Events'], ['endpoints', 'Endpoints'], ['dead', 'Dead-letter queue']];
  return (
    <>
      <header>
        <h1>RelayX</h1>
        <nav>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <button className="btn gray" onClick={() => { sessionStorage.removeItem(KEY_STORAGE); setApiKey(''); }}>Sign out</button>
      </header>
      <main>
        {tab === 'dashboard' && <Dashboard client={client} />}
        {tab === 'events' && <Events client={client} />}
        {tab === 'endpoints' && <Endpoints client={client} />}
        {tab === 'dead' && <DeadLetters client={client} />}
      </main>
    </>
  );
}

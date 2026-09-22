import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, defaultBase, getBase, getToken, request, setBase, setToken } from './api.js';
import { ApplicationsPage } from './pages/applications.js';
import { OverviewPage } from './pages/overview.js';
import { PolicyPage } from './pages/policy.js';
import { RequestsPage } from './pages/requests.js';
import { UsagePage } from './pages/usage.js';
import { WalletPage } from './pages/wallet.js';

const APP_KEY = 'aetherdust.application-id';

/** Tiny hash router — six pages do not need a routing library. */
export const useRoute = (): [string, (to: string) => void] => {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/overview');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/overview');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [hash, (to: string) => { window.location.hash = to; }];
};

/** The selected application is dashboard-wide state: most pages are scoped to one DApp. */
export const useSelectedApp = (): [string | null, (id: string) => void] => {
  const [id, setId] = useState<string | null>(() => localStorage.getItem(APP_KEY));
  return [id, (next: string) => { localStorage.setItem(APP_KEY, next); setId(next); }];
};

const NAV: { to: string; label: string }[] = [
  { to: '/overview', label: 'Overview' },
  { to: '/requests', label: 'Requests' },
  { to: '/usage', label: 'Usage' },
  { to: '/policy', label: 'Policy' },
  { to: '/applications', label: 'Applications' },
  { to: '/wallet', label: 'Wallet' },
];

const Login = ({ onDone }: { onDone: () => void }) => {
  const [token, setTok] = useState('');
  const [base, setBaseInput] = useState(getBase() || defaultBase());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    setBase(base); setToken(token.trim());
    try {
      await request('/v1/admin/applications'); // the cheapest authenticated call
      onDone();
    } catch (err) {
      setToken(null);
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand"><span className="dot" aria-hidden />AetherDust</div>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Operator dashboard. Sign in with the admin token (<code>AETHERDUST_ADMIN_TOKEN</code>).</p>
        <label className="field">API base URL
          <input value={base} onChange={(e) => setBaseInput(e.target.value)} placeholder="http://localhost:8080" autoComplete="off" />
        </label>
        <label className="field">Admin token
          <input value={token} onChange={(e) => setTok(e.target.value)} type="password" autoComplete="off" autoFocus />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Sign in'}</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>The token is kept in this tab only (sessionStorage) and is never written to disk.</span>
      </form>
    </div>
  );
};

const Shell = ({ onSignOut }: { onSignOut: () => void }) => {
  const [route] = useRoute();
  const path = route.split('?')[0]!;
  const qc = useQueryClient();
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem('aetherdust.theme', theme);
  }, [theme]);

  // an element, not a component defined during render: a fresh component identity would remount the page every time
  const page = path === '/requests' ? <RequestsPage />
    : path === '/usage' ? <UsagePage />
      : path === '/policy' ? <PolicyPage />
        : path === '/applications' ? <ApplicationsPage />
          : path === '/wallet' ? <WalletPage />
            : <OverviewPage />;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand"><span className="dot" aria-hidden />AetherDust</div>
        <div className="nav">
          {NAV.map((n) => <a key={n.to} href={`#${n.to}`} aria-current={path === n.to ? 'page' : undefined}>{n.label}</a>)}
        </div>
        <div className="sidebar-foot">
          <label className="field">Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
            </select>
          </label>
          <span className="mono">{getBase().replace(/^https?:\/\//, '')}</span>
          <button className="ghost" onClick={() => { qc.clear(); onSignOut(); }}>Sign out</button>
        </div>
      </nav>
      <main className="main">{page}</main>
    </div>
  );
};

const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 5_000,
      retry: (count, err) => !(err instanceof ApiError && (err.isAuth || err.status === 404)) && count < 2,
    },
  },
});

export const App = () => {
  const [authed, setAuthed] = useState(() => !!getToken());
  // any 401 from any query means the operator token is gone or wrong: back to the login screen
  useEffect(() => {
    const unsub = client.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.query.state.error instanceof ApiError && e.query.state.error.isAuth) { setToken(null); setAuthed(false); }
    });
    return () => unsub();
  }, []);
  return (
    <QueryClientProvider client={client}>
      {authed ? <Shell onSignOut={() => { setToken(null); setAuthed(false); }} /> : <Login onDone={() => setAuthed(true)} />}
    </QueryClientProvider>
  );
};

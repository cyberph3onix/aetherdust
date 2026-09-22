import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ApiKey } from '../api.js';
import { useSelectedApp } from '../app.js';
import { Card, Empty, ErrorBanner, Meter, Pill, StatusPill, num, when } from '../components/ui.js';

const keyId = (k: ApiKey) => k.keyId ?? k.key_id ?? k.id;

/** Applications and their API keys (PRD §19, plan §16). A key's token is shown exactly once, at creation. */
export const ApplicationsPage = () => {
  const qc = useQueryClient();
  const [selected, select] = useSelectedApp();
  const [name, setName] = useState('');
  const [freshToken, setFreshToken] = useState<{ application: string; token: string } | null>(null);

  const apps = useQuery({ queryKey: ['applications'], queryFn: api.applications });
  const create = useMutation({
    mutationFn: (n: string) => api.createApplication(n),
    onSuccess: (a) => { setName(''); select(a.id); void qc.invalidateQueries({ queryKey: ['applications'] }); },
  });

  return (
    <>
      <div className="page-head">
        <div><h1>Applications</h1><p>Each DApp gets its own API keys, policy and budget.</p></div>
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New application name" aria-label="New application name" />
          <button className="primary" type="submit" disabled={!name.trim() || create.isPending}>Create</button>
        </form>
      </div>

      {apps.error && <ErrorBanner error={apps.error} />}
      {create.error && <ErrorBanner error={create.error} />}
      {freshToken && (
        <Card title="New API key — copy it now" className="" actions={<button className="ghost" onClick={() => setFreshToken(null)}>Dismiss</button>}>
          <p style={{ marginTop: 0 }}>This token for <strong>{freshToken.application}</strong> is shown once and cannot be recovered. Store it in the DApp's secrets.</p>
          <code style={{ display: 'block', padding: 10, background: 'var(--plane)', borderRadius: 8, overflowWrap: 'anywhere' }}>{freshToken.token}</code>
          <button style={{ marginTop: 10 }} onClick={() => void navigator.clipboard?.writeText(freshToken.token)}>Copy</button>
        </Card>
      )}

      {apps.isPending ? <Empty>Loading…</Empty>
        : apps.data!.length === 0 ? <Empty>No applications yet.</Empty>
          : <div style={{ display: 'grid', gap: 14 }}>
            {apps.data!.map((a) => (
              <ApplicationCard key={a.id} id={a.id} selected={selected === a.id} onSelect={() => select(a.id)} onToken={(t) => setFreshToken({ application: a.name, token: t })} />
            ))}
          </div>}
    </>
  );
};

const ApplicationCard = ({ id, selected, onSelect, onToken }: { id: string; selected: boolean; onSelect: () => void; onToken: (token: string) => void }) => {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['application', id], queryFn: () => api.application(id) });
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['application', id] }); void qc.invalidateQueries({ queryKey: ['applications'] }); };
  const [env, setEnv] = useState<'live' | 'test'>('live');
  const [label, setLabel] = useState('');

  const createKey = useMutation({ mutationFn: () => api.createApiKey(id, env, label || undefined), onSuccess: (r) => { setLabel(''); onToken(r.token); invalidate(); } });
  const revoke = useMutation({ mutationFn: (kid: string) => api.revokeApiKey(kid), onSuccess: invalidate });
  const setStatus = useMutation({ mutationFn: (s: 'active' | 'suspended') => api.setApplicationStatus(id, s), onSuccess: invalidate });

  const a = q.data;
  return (
    <Card
      title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>{a?.name ?? '…'}{selected && <Pill tone="info">selected</Pill>}</span>}
      actions={
        <div className="toolbar">
          {!selected && <button className="ghost" onClick={onSelect}>Select</button>}
          {a && <button className={a.status === 'active' ? 'danger' : ''} onClick={() => setStatus.mutate(a.status === 'active' ? 'suspended' : 'active')} disabled={setStatus.isPending}>
            {a.status === 'active' ? 'Suspend' : 'Reactivate'}
          </button>}
        </div>
      }
    >
      {q.error && <ErrorBanner error={q.error} />}
      {!a ? <Empty>Loading…</Empty> : (
        <>
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <dl className="kv">
              <dt>Status</dt><dd><StatusPill status={a.status} /></dd>
              <dt>Id</dt><dd>{a.id}</dd>
              <dt>Policy</dt><dd>{a.policy ? `v${a.policy.version}` : 'none — sponsorship is refused'}</dd>
            </dl>
            <div>
              <h3>Budget this period</h3>
              {a.current_period
                ? <Meter settled={a.current_period.settled_dust} reserved={a.current_period.reserved_dust} limit={a.current_period.limit_dust}
                    caption={<>since {when(a.current_period.start)}</>} />
                : <p className="empty" style={{ padding: 0 }}>No policy, no budget.</p>}
            </div>
            <div>
              <h3>Requests</h3>
              <p style={{ margin: 0 }}>
                {Object.entries(a.counts).length === 0 ? <span style={{ color: 'var(--text-muted)' }}>none yet</span>
                  : Object.entries(a.counts).sort().map(([s, n]) => <span key={s} style={{ marginRight: 10 }}><StatusPill status={s} /> {num(n)}</span>)}
              </p>
            </div>
          </div>

          <h3>API keys</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Key id</th><th>Env</th><th>Label</th><th>Status</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {a.keys.length === 0 ? <tr><td colSpan={6} className="empty">No keys yet.</td></tr> : a.keys.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">{keyId(k)}</td>
                    <td>{k.env}</td>
                    <td>{k.label ?? '—'}</td>
                    <td><StatusPill status={k.status === 'active' ? 'active' : 'rejected'} /></td>
                    <td>{when(k.lastUsedAt ?? null)}</td>
                    <td className="num">{k.status === 'active' && <button className="danger ghost" onClick={() => revoke.mutate(k.id)} disabled={revoke.isPending}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="toolbar" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); createKey.mutate(); }}>
            <label className="field">Environment
              <select value={env} onChange={(e) => setEnv(e.target.value as 'live' | 'test')}><option value="live">live</option><option value="test">test</option></select>
            </label>
            <label className="field">Label
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
            </label>
            <button type="submit" disabled={createKey.isPending}>Create API key</button>
          </form>
          {createKey.error && <div style={{ marginTop: 10 }}><ErrorBanner error={createKey.error} /></div>}
          {revoke.error && <div style={{ marginTop: 10 }}><ErrorBanner error={revoke.error} /></div>}
        </>
      )}
    </Card>
  );
};

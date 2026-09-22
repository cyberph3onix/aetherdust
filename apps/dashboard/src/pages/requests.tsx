import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type SponsorshipRequest } from '../api.js';
import { AppPicker, useApplicationScope } from '../components/app-picker.js';
import { Card, Drawer, Empty, ErrorBanner, Pill, StatusPill, ago, dust, num, short, when } from '../components/ui.js';

const STATUSES = ['', 'RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'SPONSORING_FAILED', 'SUBMISSION_FAILED', 'TIMEOUT', 'EXPIRED', 'UNKNOWN'];

/** PRD §19.2: request id, user, contract, entry point, DUST, timestamp, status, transaction id — plus the audit trail. */
export const RequestsPage = () => {
  const scope = useApplicationScope();
  const [status, setStatus] = useState('');
  const [user, setUser] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['requests', scope.applicationId, status, user],
    queryFn: () => api.requests(scope.applicationId!, { status: status || undefined, user_id: user || undefined, limit: 200 }),
    enabled: !!scope.applicationId,
    refetchInterval: 10_000,
  });

  return (
    <>
      <div className="page-head">
        <div><h1>Requests</h1><p>Every sponsorship request, with its full audit trail.</p></div>
        <div className="toolbar">
          <AppPicker value={scope.applicationId} applications={scope.applications} onChange={scope.select} />
          <label className="field">Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || 'any'}</option>)}
            </select>
          </label>
          <label className="field">User
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="user id" />
          </label>
        </div>
      </div>

      {scope.error && <ErrorBanner error={scope.error} />}
      {list.error && <ErrorBanner error={list.error} />}
      <Card actions={list.data ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{num(list.data.length)} shown</span> : null}>
        {!scope.applicationId ? <Empty>Create an application first.</Empty>
          : list.isPending ? <Empty>Loading…</Empty>
            : list.data!.length === 0 ? <Empty>No requests match this filter.</Empty> : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Request id</th><th>User</th><th>Contract</th><th>Entry point</th>
                      <th className="num">DUST</th><th>Status</th><th>Transaction id</th><th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data!.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => setOpenId(r.id)}>
                        <td className="mono">{short(r.request_id, 16, 6)}</td>
                        <td className="mono">{short(r.user_id, 12, 4)}</td>
                        <td className="mono" title={r.contract ?? ''}>{short(r.contract, 8, 6)}</td>
                        <td className="mono">{r.entry_point ?? '—'}</td>
                        <td className="num">{dust(r.sponsored_dust ?? r.estimated_fee_dust)}</td>
                        <td><StatusPill status={r.internal_status} /></td>
                        <td className="mono" title={r.transaction_id ?? ''}>{short(r.transaction_id, 8, 6)}</td>
                        <td title={when(r.created_at)}>{ago(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>

      {openId && <RequestDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
};

const RequestDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const q = useQuery({ queryKey: ['request', id], queryFn: () => api.requestDetail(id), refetchInterval: 5_000 });
  const r = q.data as (SponsorshipRequest & { events: { id: number; from: string | null; to: string; reason_code: string | null; details: unknown; at: string }[] }) | undefined;
  return (
    <Drawer title={r ? `Request ${short(r.request_id, 18, 8)}` : 'Request'} onClose={onClose}>
      {q.error && <ErrorBanner error={q.error} />}
      {!r ? <Empty>Loading…</Empty> : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <StatusPill status={r.internal_status} />
            <Pill>public: {r.status}</Pill>
            {r.policy_version != null && <Pill>policy v{r.policy_version}</Pill>}
            {r.attempts > 1 && <Pill tone="warn">{r.attempts} attempts</Pill>}
          </div>
          {r.error && <div className="error-banner" style={{ marginBottom: 14 }}><strong>{r.error.code}</strong> — {r.error.message}</div>}
          <dl className="kv" style={{ marginBottom: 18 }}>
            <dt>Internal id</dt><dd>{r.id}</dd>
            <dt>User</dt><dd>{r.user_id}</dd>
            <dt>Calls</dt><dd>{r.calls.map((c) => `${c.contract}:${c.entry_point}`).join(', ') || '—'}</dd>
            <dt>Estimated fee</dt><dd>{dust(r.estimated_fee_dust)} DUST</dd>
            <dt>Reserved</dt><dd>{dust(r.reserved_dust)} DUST</dd>
            <dt>Sponsored</dt><dd>{dust(r.sponsored_dust)} DUST</dd>
            <dt>User tx hash</dt><dd>{r.user_transaction_hash}</dd>
            <dt>Merged tx hash</dt><dd>{r.transaction_hash ?? '—'}</dd>
            <dt>Transaction id</dt><dd>{r.transaction_id ?? '—'}</dd>
            <dt>Block</dt><dd>{r.block_height ?? '—'}</dd>
            <dt>Created</dt><dd>{when(r.created_at)}</dd>
            <dt>Submitted</dt><dd>{when(r.submitted_at)}</dd>
            <dt>Confirmed</dt><dd>{when(r.confirmed_at)}</dd>
          </dl>
          <h3 style={{ marginBottom: 8 }}>Audit trail</h3>
          <ul className="timeline">
            {r.events.map((e) => (
              <li key={e.id}>
                <span className="when">{when(e.at)}</span>
                <span>
                  <strong>{e.from ? `${e.from} → ${e.to}` : e.to}</strong>
                  {e.reason_code && <> · <span style={{ color: 'var(--text-secondary)' }}>{e.reason_code}</span></>}
                  {e.details != null && <pre className="mono" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{JSON.stringify(e.details)}</pre>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Drawer>
  );
};

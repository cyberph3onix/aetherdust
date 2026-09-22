import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type DryRun } from '../api.js';
import { AppPicker, useApplicationScope } from '../components/app-picker.js';
import { Card, Empty, ErrorBanner, Pill, StatusPill, dust, num, short, when } from '../components/ui.js';

const TEMPLATE = {
  enabled: true,
  contracts: { '0000000000000000000000000000000000000000000000000000000000000000': ['increment'] },
  allow_multiple_calls: false,
  limits: { period: 'daily', global_budget_dust: '10', per_user_budget_dust: '0.5', max_fee_per_tx_dust: '0.05' },
  rate_limit: { requests_per_minute_per_credential: 60, requests_per_minute_per_user: 10, requests_per_minute_per_ip: 120 },
  preflight: { min_ttl_remaining_seconds: 300, max_tx_bytes: 524288 },
};

/**
 * PRD §19.3 — the policy editor. The document is edited as JSON (it is the same document the API validates), and
 * a dry run replays the last N stored requests through the candidate before anything is saved: the operator sees
 * exactly which traffic the change would have rejected or admitted.
 */
export const PolicyPage = () => {
  const scope = useApplicationScope();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRun | null>(null);

  const policy = useQuery({ queryKey: ['policy', scope.applicationId], queryFn: () => api.policy(scope.applicationId!), enabled: !!scope.applicationId });

  useEffect(() => {
    if (policy.data) setDraft(JSON.stringify(policy.data.active?.document ?? TEMPLATE, null, 2));
    setDryRun(null);
  }, [policy.data, scope.applicationId]);

  const parsed = (): unknown | null => {
    try { const v = JSON.parse(draft); setJsonError(null); return v; } catch (e) { setJsonError((e as Error).message); return null; }
  };

  const save = useMutation({
    mutationFn: async () => { const doc = parsed(); if (!doc) throw new Error('fix the JSON first'); return api.putPolicy(scope.applicationId!, doc); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['policy', scope.applicationId] }); void qc.invalidateQueries({ queryKey: ['overview'] }); },
  });
  const check = useMutation({
    mutationFn: async () => { const doc = parsed(); if (!doc) throw new Error('fix the JSON first'); return api.dryRunPolicy(scope.applicationId!, doc, 200); },
    onSuccess: setDryRun,
  });

  const active = policy.data?.active;
  const dirty = !!active && draft.trim() !== JSON.stringify(active.document, null, 2).trim();

  return (
    <>
      <div className="page-head">
        <div><h1>Policy</h1><p>Allowlists, budgets, limits and rate limits. Saving appends a new version; it applies to the next request.</p></div>
        <div className="toolbar"><AppPicker value={scope.applicationId} applications={scope.applications} onChange={scope.select} /></div>
      </div>

      {scope.error && <ErrorBanner error={scope.error} />}
      {policy.error && <ErrorBanner error={policy.error} />}
      {!scope.applicationId ? <Empty>Create an application first.</Empty> : (
        <div className="grid cols-2">
          <Card
            title={active ? `Active policy · v${active.version}` : 'No policy yet'}
            actions={<div className="toolbar">
              <button className="ghost" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? 'Checking…' : 'Dry run'}</button>
              <button className="primary" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>{save.isPending ? 'Saving…' : 'Save new version'}</button>
            </div>}
          >
            <textarea rows={26} value={draft} onChange={(e) => { setDraft(e.target.value); setJsonError(null); }} spellCheck={false} aria-label="Policy document (JSON)" />
            {jsonError && <div className="error-banner" style={{ marginTop: 10 }}>Invalid JSON — {jsonError}</div>}
            {save.error && <div style={{ marginTop: 10 }}><ErrorBanner error={save.error} /></div>}
            {check.error && <div style={{ marginTop: 10 }}><ErrorBanner error={check.error} /></div>}
            {save.isSuccess && !dirty && <p style={{ color: 'var(--good-text)', marginBottom: 0 }}>Saved as v{save.data.version}.</p>}
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 0 }}>
              {dirty ? 'Unsaved changes.' : 'No changes.'} Versions: {policy.data?.versions.map((v) => `v${v.version}`).join(', ') || '—'}
            </p>
          </Card>

          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <Card title="Dry run against recent traffic">
              {!dryRun ? <Empty>Run a dry run to see what this policy would have done to the last 200 requests.</Empty> : (
                <>
                  <div className="grid cols-2" style={{ marginBottom: 12 }}>
                    <div><span className="label" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Would allow</span><div className="hero" style={{ fontSize: 28 }}>{num(dryRun.summary.would_allow)}</div></div>
                    <div><span className="label" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Would reject</span><div className="hero" style={{ fontSize: 28 }}>{num(dryRun.summary.would_reject)}</div></div>
                  </div>
                  <p style={{ marginTop: 0 }}>
                    <Pill tone={dryRun.summary.newly_rejected ? 'bad' : 'good'}>{num(dryRun.summary.newly_rejected)} newly rejected</Pill>{' '}
                    <Pill tone={dryRun.summary.newly_allowed ? 'info' : undefined}>{num(dryRun.summary.newly_allowed)} newly allowed</Pill>{' '}
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>of {num(dryRun.sampled)} sampled</span>
                  </p>
                  {dryRun.by_reason.length > 0 && (
                    <table>
                      <thead><tr><th>Rejection reason</th><th className="num">Requests</th></tr></thead>
                      <tbody>{dryRun.by_reason.map((r) => <tr key={r.code}><td>{r.code}</td><td className="num">{num(r.count)}</td></tr>)}</tbody>
                    </table>
                  )}
                </>
              )}
            </Card>
            {dryRun && dryRun.requests.some((r) => r.changed) && (
              <Card title="Requests whose outcome changes">
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Request</th><th>Entry point</th><th className="num">Fee</th><th>Was</th><th>Would be</th></tr></thead>
                    <tbody>
                      {dryRun.requests.filter((r) => r.changed).slice(0, 50).map((r) => (
                        <tr key={r.id} title={r.would.message ?? ''}>
                          <td className="mono">{short(r.request_id, 14, 6)}<br /><span style={{ color: 'var(--text-muted)' }}>{when(r.created_at)}</span></td>
                          <td className="mono">{r.entry_point ?? '—'}</td>
                          <td className="num">{dust(r.fee_dust)}</td>
                          <td><StatusPill status={r.was.status} /></td>
                          <td>{r.would.allowed ? <Pill tone="good">allowed</Pill> : <Pill tone="bad">{r.would.code}</Pill>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
};

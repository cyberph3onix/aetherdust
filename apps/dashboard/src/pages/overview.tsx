import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type OverviewApp } from '../api.js';
import { DustOverTime } from '../components/charts.js';
import { Bars, Card, ErrorBanner, Meter, Pill, Stat, StatusPill, ago, dust, night, num, seconds, short, when } from '../components/ui.js';
import { useSelectedApp } from '../app.js';

const WINDOWS: { label: string; hours: number; bucket: 'hour' | 'day' }[] = [
  { label: '24 hours', hours: 24, bucket: 'hour' },
  { label: '7 days', hours: 24 * 7, bucket: 'day' },
  { label: '30 days', hours: 24 * 30, bucket: 'day' },
];

const walletTone = (w: { synced: boolean; healthy: boolean } | null | undefined) =>
  !w ? 'warn' : w.healthy && w.synced ? 'good' : w.synced ? 'bad' : 'warn';

export const OverviewPage = () => {
  const [w, setW] = useState(0);
  const win = WINDOWS[w]!;
  const [, selectApp] = useSelectedApp();
  const { data, error, isPending, dataUpdatedAt } = useQuery({
    queryKey: ['overview', win.hours, win.bucket],
    queryFn: () => api.overview({ hours: win.hours, bucket: win.bucket, recent: 15 }),
    refetchInterval: 10_000, // PRD §19: the overview refreshes every 10s
  });

  if (error) return <ErrorBanner error={error} />;
  if (isPending || !data) return <p className="empty">Loading…</p>;

  const wallet = data.wallet.live ?? data.wallet.snapshot;
  const attempted = data.totals.confirmed + data.totals.rejected + data.totals.failed;
  const successRate = attempted ? (data.totals.confirmed / attempted) * 100 : null;
  const open = (a: OverviewApp) => { selectApp(a.id); window.location.hash = '/usage'; };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>{data.adapter} sponsor on <strong>{data.network}</strong> · updated {ago(new Date(dataUpdatedAt).toISOString())}</p>
        </div>
        <div className="toolbar">
          {WINDOWS.map((x, i) => (
            <button key={x.label} className={i === w ? 'primary' : 'ghost'} onClick={() => setW(i)}>{x.label}</button>
          ))}
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Card><Stat label="DUST sponsored (all time)" value={dust(data.totals.sponsored_dust)} unit="DUST" hint={`${num(data.totals.confirmed)} confirmed sponsorships`} /></Card>
        <Card><Stat label="Sponsor wallet" value={wallet ? dust(wallet.dust_balance_dust) : '—'} unit="DUST"
          hint={wallet ? <>{wallet.dust_coins} DUST coin{wallet.dust_coins === 1 ? '' : 's'} · {night(wallet.night)} NIGHT</> : 'no wallet snapshot yet'} /></Card>
        <Card><Stat label="Success rate" value={successRate == null ? '—' : `${successRate.toFixed(1)}%`}
          hint={<>{num(data.totals.rejected)} rejected · {num(data.totals.failed)} failed · {num(data.totals.pending)} in flight</>} /></Card>
        <Card><Stat label="Confirmation p95" value={seconds(data.confirmation_latency.p95_seconds)}
          hint={<>median {seconds(data.confirmation_latency.p50_seconds)} · {num(data.confirmation_latency.count)} in window</>} /></Card>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <Card title="DUST sponsored over time" actions={<span className="hint" style={{ fontSize: 12, color: 'var(--text-muted)' }}>per {win.bucket}</span>}>
          <DustOverTime data={data.series} bucket={win.bucket} />
        </Card>
        <Card title="Sponsor wallet" actions={<Pill tone={walletTone(wallet)}>{!wallet ? 'unknown' : !wallet.synced ? 'syncing' : wallet.healthy ? 'healthy' : 'unhealthy'}</Pill>}>
          {wallet ? (
            <dl className="kv">
              <dt>Adapter</dt><dd>{wallet.adapter} · {wallet.network}</dd>
              <dt>DUST</dt><dd>{dust(wallet.dust_balance_dust)}{wallet.dust_cap_dust ? ` / cap ${dust(wallet.dust_cap_dust)}` : ''}</dd>
              <dt>NIGHT</dt><dd>{night(wallet.night)}</dd>
              <dt>Coins</dt><dd>{wallet.dust_coins} free · {wallet.dust_coins_in_flight} in flight</dd>
              <dt>Source</dt><dd>{data.wallet.live ? 'live from the worker' : `snapshot ${ago(data.wallet.snapshot?.taken_at)}`}</dd>
            </dl>
          ) : <p className="empty">The worker has not reported a wallet snapshot yet.</p>}
        </Card>
      </div>

      <Card title="Applications" className="" actions={<a href="#/applications">Manage →</a>}>
        {data.applications.length === 0 ? <p className="empty">No applications yet — create one on the Applications page.</p> : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Application</th><th>Status</th><th>Policy</th><th style={{ minWidth: 220 }}>Budget this period</th>
                  <th className="num">Sponsored</th><th className="num">Confirmed</th><th className="num">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => open(a)}>
                    <td><strong>{a.name}</strong><br /><span className="mono" style={{ color: 'var(--text-muted)' }}>{short(a.id, 8, 4)}</span></td>
                    <td><StatusPill status={a.status} /></td>
                    <td>{a.policy ? <>v{a.policy.version} · {a.policy.contracts} contract{a.policy.contracts === 1 ? '' : 's'}{a.policy.enabled ? '' : ' · disabled'}</> : <span style={{ color: 'var(--critical)' }}>none</span>}</td>
                    <td>{a.budget ? <Meter settled={a.budget.settled_dust} reserved={a.budget.reserved_dust} limit={a.budget.limit_dust} /> : '—'}</td>
                    <td className="num">{dust(a.sponsored_dust)}</td>
                    <td className="num">{num(a.confirmed_total)}</td>
                    <td className="num">{num(a.counts.REJECTED ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Rejections in window">
          <Bars unit="requests" rows={data.rejections.map((r) => ({ key: r.code, label: r.code, value: r.count, display: num(r.count) }))} />
        </Card>
        <Card title="Recent requests" actions={<a href="#/requests">All →</a>}>
          {data.recent_requests.length === 0 ? <p className="empty">No requests yet.</p> : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Request</th><th>User</th><th>Entry point</th><th className="num">DUST</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {data.recent_requests.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{short(r.request_id, 14, 6)}</td>
                      <td className="mono">{short(r.user_id, 10, 4)}</td>
                      <td className="mono">{r.entry_point ?? '—'}</td>
                      <td className="num">{dust(r.sponsored_dust ?? r.estimated_fee_dust)}</td>
                      <td><StatusPill status={r.internal_status} /></td>
                      <td title={when(r.created_at)}>{ago(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
};

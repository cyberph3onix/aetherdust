import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { AppPicker, useApplicationScope } from '../components/app-picker.js';
import { DustOverTime } from '../components/charts.js';
import { Bars, Card, Empty, ErrorBanner, Stat, dust, num, short } from '../components/ui.js';

const WINDOWS: { label: string; hours: number; bucket: 'hour' | 'day' }[] = [
  { label: '24 hours', hours: 24, bucket: 'hour' },
  { label: '7 days', hours: 24 * 7, bucket: 'day' },
  { label: '30 days', hours: 24 * 30, bucket: 'day' },
];

/** PRD §19.4: DUST over time, by contract, by entry point, by user, and rejected requests. */
export const UsagePage = () => {
  const scope = useApplicationScope();
  const [w, setW] = useState(1);
  const win = WINDOWS[w]!;
  const from = new Date(Date.now() - win.hours * 3_600_000).toISOString();

  const q = useQuery({
    queryKey: ['usage', scope.applicationId, win.hours, win.bucket],
    queryFn: () => api.usage(scope.applicationId!, { from, bucket: win.bucket }),
    enabled: !!scope.applicationId,
    refetchInterval: 30_000,
  });

  const rows = (xs: { sponsored_dust: string; count: number }[], key: (x: any) => string, label?: (x: any) => string) =>
    xs.slice(0, 10).map((x) => ({ key: key(x), label: label ? label(x) : key(x), value: Number(x.sponsored_dust), display: `${dust(x.sponsored_dust)} · ${num(x.count)}×` }));

  return (
    <>
      <div className="page-head">
        <div><h1>Usage</h1><p>Where the DUST went, for the selected application.</p></div>
        <div className="toolbar">
          <AppPicker value={scope.applicationId} applications={scope.applications} onChange={scope.select} />
          {WINDOWS.map((x, i) => <button key={x.label} className={i === w ? 'primary' : 'ghost'} onClick={() => setW(i)}>{x.label}</button>)}
        </div>
      </div>

      {q.error && <ErrorBanner error={q.error} />}
      {!scope.applicationId ? <Empty>Create an application first.</Empty>
        : q.isPending || !q.data ? <Empty>Loading…</Empty> : (
          <>
            <div className="grid cols-4" style={{ marginBottom: 14 }}>
              <Card><Stat label="DUST sponsored" value={dust(q.data.totals.sponsored_dust)} unit="DUST" hint={`in the last ${win.label}`} /></Card>
              <Card><Stat label="Confirmed" value={num(q.data.totals.confirmed)} /></Card>
              <Card><Stat label="Rejected" value={num(q.data.totals.rejected)} hint={`${num(q.data.totals.failed)} failed`} /></Card>
              <Card><Stat label="In flight" value={num(q.data.totals.pending)} /></Card>
            </div>

            <Card title="DUST sponsored over time" actions={<span style={{ fontSize: 12, color: 'var(--text-muted)' }}>per {win.bucket}</span>}>
              <DustOverTime data={q.data.series} bucket={win.bucket} height={260} />
            </Card>

            <div className="grid cols-2" style={{ marginTop: 14 }}>
              <Card title="By contract"><Bars rows={rows(q.data.by_contract, (x) => x.contract, (x) => short(x.contract, 10, 6))} /></Card>
              <Card title="By entry point"><Bars rows={rows(q.data.by_entry_point, (x) => x.key, (x) => x.key.split(':')[1] ?? x.key)} /></Card>
              <Card title="By user"><Bars rows={rows(q.data.by_user, (x) => x.user_id, (x) => short(x.user_id, 14, 6))} /></Card>
              <Card title="Rejected requests">
                <Bars unit="requests" rows={q.data.rejections.map((r) => ({ key: r.code, label: r.code, value: r.count, display: num(r.count) }))} />
              </Card>
            </div>

            <Card title="Table view" className="" actions={<span style={{ fontSize: 12, color: 'var(--text-muted)' }}>the numbers behind the charts</span>}>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Entry point</th><th className="num">DUST</th><th className="num">Sponsorships</th></tr></thead>
                  <tbody>
                    {q.data.by_entry_point.length === 0
                      ? <tr><td colSpan={3} className="empty">No usage in this window.</td></tr>
                      : q.data.by_entry_point.map((x) => (
                        <tr key={x.key}><td className="mono">{x.key}</td><td className="num">{dust(x.sponsored_dust)}</td><td className="num">{num(x.count)}</td></tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
    </>
  );
};

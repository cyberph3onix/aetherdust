import { useQuery } from '@tanstack/react-query';
import { api, type WalletDto } from '../api.js';
import { Card, Empty, ErrorBanner, Pill, Stat, ago, dust, night, num } from '../components/ui.js';

/**
 * Sponsor wallet page (the Phase 2 deferral). `live` comes from the worker's private RPC and can be unavailable
 * (worker restarting, wallet still syncing); the snapshot table is written every AETHERDUST_WALLET_SNAPSHOT_S and
 * is always there — which is exactly what an operator needs when the worker is the thing that is unhappy.
 */
export const WalletPage = () => {
  const q = useQuery({ queryKey: ['wallet'], queryFn: api.wallet, refetchInterval: 10_000 });
  const w: WalletDto | null = q.data?.live ?? q.data?.snapshot ?? null;
  const state = !w ? 'unknown' : !w.synced ? 'syncing' : w.healthy ? 'healthy' : 'unhealthy';

  return (
    <>
      <div className="page-head">
        <div><h1>Sponsor wallet</h1><p>The wallet that pays the DUST. It is never reachable from the api process — these numbers come from the worker.</p></div>
        <Pill tone={state === 'healthy' ? 'good' : state === 'unhealthy' ? 'bad' : 'warn'}>{state}</Pill>
      </div>

      {q.error && <ErrorBanner error={q.error} />}
      {!w ? <Empty>{q.isPending ? 'Loading…' : 'No wallet information yet — is the worker running?'}</Empty> : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <Card><Stat label="DUST balance" value={dust(w.dust_balance_dust)} unit="DUST" hint={w.dust_cap_dust ? `cap ${dust(w.dust_cap_dust)}` : undefined} /></Card>
            <Card><Stat label="NIGHT" value={night(w.night)} hint="generates the DUST" /></Card>
            <Card><Stat label="Spendable DUST coins" value={num(w.dust_coins)} hint={`${num(w.dust_coins_in_flight)} in flight — this bounds worker concurrency`} /></Card>
            <Card><Stat label="Max in flight" value={num(w.max_in_flight ?? w.dust_coins)} hint="sponsorships the wallet can start now" /></Card>
          </div>

          <div className="grid cols-2">
            <Card title="Details">
              <dl className="kv">
                <dt>Adapter</dt><dd>{w.adapter}</dd>
                <dt>Network</dt><dd>{w.network}</dd>
                <dt>Synced</dt><dd>{String(w.synced)}</dd>
                <dt>Healthy</dt><dd>{String(w.healthy)}</dd>
                <dt>Source</dt><dd>{q.data?.live ? 'live (worker RPC)' : `last snapshot ${ago(q.data?.snapshot?.taken_at)}`}</dd>
                {q.data?.snapshot?.taken_at && <><dt>Snapshot</dt><dd>{ago(q.data.snapshot.taken_at)}</dd></>}
              </dl>
            </Card>
            <Card title="Adapter detail">
              <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                {w.detail ? JSON.stringify(w.detail, null, 2) : 'none'}
              </pre>
            </Card>
          </div>

          <Card title="Runbook" className="" >
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
              <li><strong>Low DUST</strong> — the worker refuses to sponsor below <code>AETHERDUST_MIN_SPONSOR_DUST</code>. Fund the wallet with NIGHT and wait for DUST to generate.</li>
              <li><strong>Zero DUST coins</strong> — register the NIGHT UTXOs for DUST generation: <code>docker compose run --rm worker wallet register-dust</code>.</li>
              <li><strong>Not syncing</strong> — check the indexer URL and the worker logs; a public network sync can take hours from scratch.</li>
            </ul>
          </Card>
        </>
      )}
    </>
  );
};

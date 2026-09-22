import type { ReactNode } from 'react';

/** Formatting helpers. DUST amounts arrive as exact decimal strings — never parse them for display, only for widths. */
export const dust = (v: string | null | undefined, places = 6): string => {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n === 0) return '0';
  if (n < 10 ** -places) return `<0.${'0'.repeat(places - 1)}1`;
  return n.toLocaleString(undefined, { maximumFractionDigits: places });
};
export const num = (n: number | null | undefined): string => (n == null ? '—' : n.toLocaleString());
/** NIGHT arrives as a decimal string; group it so 250000000 reads as a balance rather than an id. */
export const night = (v: string | null | undefined): string => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 }));
export const seconds = (s: number | null | undefined): string => (s == null ? '—' : s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`);
export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');
export const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const short = (s: string | null | undefined, head = 8, tail = 6): string =>
  !s ? '—' : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export const Card = ({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card${className ? ` ${className}` : ''}`}>
    {(title || actions) && <div className="card-head">{title ? <h2>{title}</h2> : <span />}{actions}</div>}
    {children}
  </section>
);

export const Stat = ({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode }) => (
  <div className="stat">
    <span className="label">{label}</span>
    <span className="value">{value}{unit && <span className="unit">{unit}</span>}</span>
    {hint && <span className="hint">{hint}</span>}
  </div>
);

/** Status is never colour alone: every pill carries its label, and the dot is a secondary cue. */
const TONE: Record<string, 'good' | 'warn' | 'bad' | 'info'> = {
  confirmed: 'good', CONFIRMED: 'good', active: 'good', approved: 'info', pending: 'info',
  RECEIVED: 'info', RESERVED: 'info', SPONSORING: 'info', SUBMITTED: 'info',
  TIMEOUT: 'warn', UNKNOWN: 'warn', suspended: 'warn',
  rejected: 'bad', REJECTED: 'bad', failed: 'bad', EXPIRED: 'bad', SPONSORING_FAILED: 'bad', SUBMISSION_FAILED: 'bad',
};
export const Pill = ({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' }) => (
  <span className={`pill${tone ? ` ${tone}` : ''}`}><span className="marker" aria-hidden />{children}</span>
);
export const StatusPill = ({ status }: { status: string }) => <Pill tone={TONE[status]}>{status.toLowerCase().replace(/_/g, ' ')}</Pill>;

/** A single ratio against a limit — a meter, not a pie (settled and reserved share one track). */
export const Meter = ({ settled, reserved, limit, caption }: { settled: string; reserved: string; limit: string; caption?: ReactNode }) => {
  const lim = Number(limit) || 0;
  const pct = (v: string) => (lim > 0 ? Math.min(100, (Number(v) / lim) * 100) : 0);
  const s = pct(settled); const r = pct(reserved);
  return (
    <div className="meter">
      <div className="bar" role="img" aria-label={`${dust(settled)} of ${dust(limit)} DUST spent, ${dust(reserved)} reserved`}>
        <div className="fill" style={{ width: `${s}%` }} />
        <div className="fill reserved" style={{ left: `${s}%`, width: `${r}%`, right: 'auto' }} />
      </div>
      <div className="row"><span>{caption ?? <>{dust(settled)} spent · {dust(reserved)} reserved</>}</span><span>limit {dust(limit)}</span></div>
    </div>
  );
};

/** Horizontal bars for a ranked breakdown: one series, one colour, value labelled on every row. */
export const Bars = ({ rows, unit = 'DUST' }: { rows: { key: string; label: ReactNode; value: number; display: string }[]; unit?: string }) => {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length) return <p className="empty">No data in this window.</p>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="row" key={r.key} title={`${r.display} ${unit}`}>
          <span className="name">{r.label}</span>
          <span className="track"><span className="fill" style={{ width: `${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%` }} /></span>
          <span className="val">{r.display}</span>
        </div>
      ))}
    </div>
  );
};

export const ErrorBanner = ({ error }: { error: unknown }) => {
  const e = error as { code?: string; message?: string };
  return <div className="error-banner"><strong>{e?.code ?? 'Error'}</strong> — {e?.message ?? String(error)}</div>;
};

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export const Drawer = ({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) => (
  <div className="drawer-backdrop" onClick={onClose} role="presentation">
    <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
      <div className="drawer-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
      {children}
    </aside>
  </div>
);

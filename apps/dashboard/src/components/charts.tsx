import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dust, num } from './ui.js';

/**
 * One chart form, used everywhere a quantity moves over time: a single-series area (DUST sponsored per bucket).
 * One series → no legend box (the card title names it), 2px line, 10% wash, hairline grid, hover crosshair.
 * Counts are shown in the tooltip rather than on a second y-axis — dual axes invent correlations.
 */
export interface Point { bucket: string; sponsored_dust: string; count: number }

const tick = (iso: string, bucket: 'hour' | 'day') =>
  new Date(iso).toLocaleString(undefined, bucket === 'hour' ? { hour: 'numeric', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });

const TooltipBody = ({ active, payload, bucket }: { active?: boolean; payload?: { payload: Point }[]; bucket: 'hour' | 'day' }) => {
  const p = active && payload?.length ? payload[0]!.payload : null;
  if (!p) return null;
  return (
    <div className="tooltip">
      <div className="t-label">{new Date(p.bucket).toLocaleString(undefined, bucket === 'hour' ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })}</div>
      <div className="t-value">{dust(p.sponsored_dust)} DUST</div>
      <div className="t-label">{num(p.count)} sponsorship{p.count === 1 ? '' : 's'}</div>
    </div>
  );
};

export const DustOverTime = ({ data, bucket, height = 220 }: { data: Point[]; bucket: 'hour' | 'day'; height?: number }) => {
  if (!data.length) return <p className="empty">Nothing sponsored in this window yet.</p>;
  const rows = data.map((d) => ({ ...d, value: Number(d.sponsored_dust) }));
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="ad-wash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis dataKey="bucket" tickFormatter={(v: string) => tick(v, bucket)} stroke="var(--axis)" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} minTickGap={28} />
          <YAxis stroke="var(--axis)" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} width={64}
            tickFormatter={(v: number) => (v === 0 ? '0' : dust(String(v), 6))} />
          <Tooltip content={<TooltipBody bucket={bucket} />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
          <Area type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={2} fill="url(#ad-wash)"
            activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2, fill: 'var(--series-1)' }} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

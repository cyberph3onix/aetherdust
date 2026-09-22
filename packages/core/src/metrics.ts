/**
 * Minimal Prometheus registry (PRD §25). Pure data + text exposition, no I/O — the processes own their own
 * registry and register collectors for anything that has to be read at scrape time (Postgres, wallet snapshot).
 *
 * Why not prom-client: the metric set here is small and half of it is derived from Postgres on scrape; a 120-line
 * registry keeps `packages/core` dependency-free and makes the exposition format itself unit-testable.
 */

export type Labels = Record<string, string | number | undefined>;
export type MetricType = 'counter' | 'gauge' | 'histogram';

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Prometheus label values escape `\`, `"` and newlines; everything else is literal UTF-8. */
const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
/** Help text escapes `\` and newlines only. */
const escapeHelp = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const keyOf = (names: readonly string[], labels: Labels): string =>
  names.map((n) => escapeLabel(String(labels[n] ?? ''))).join('\u0001');

const renderLabels = (names: readonly string[], key: string, extra?: [string, string]): string => {
  const values = key === '' && names.length === 0 ? [] : key.split('\u0001');
  const parts = names.map((n, i) => `${n}="${values[i] ?? ''}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

/** Prometheus wants integers rendered without exponent and `+Inf` for the histogram overflow bucket. */
const num = (v: number): string => (Number.isFinite(v) ? (Number.isInteger(v) ? v.toString() : String(v)) : v > 0 ? '+Inf' : '-Inf');

abstract class Metric {
  abstract readonly type: MetricType;
  constructor(readonly name: string, readonly help: string, readonly labelNames: readonly string[] = []) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
  }
  abstract render(): string[];
  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  readonly type = 'counter' as const;
  #values = new Map<string, number>();
  inc(labels: Labels = {}, by = 1): void {
    const k = keyOf(this.labelNames, labels);
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }
  /** Counters must exist before they are incremented, or a dashboard cannot tell "zero" from "never happened". */
  init(labels: Labels = {}): void {
    const k = keyOf(this.labelNames, labels);
    if (!this.#values.has(k)) this.#values.set(k, 0);
  }
  get(labels: Labels = {}): number { return this.#values.get(keyOf(this.labelNames, labels)) ?? 0; }
  render(): string[] {
    return [...this.header(), ...[...this.#values].map(([k, v]) => `${this.name}${renderLabels(this.labelNames, k)} ${num(v)}`)];
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  #values = new Map<string, number>();
  set(value: number, labels: Labels = {}): void { this.#values.set(keyOf(this.labelNames, labels), value); }
  inc(labels: Labels = {}, by = 1): void { const k = keyOf(this.labelNames, labels); this.#values.set(k, (this.#values.get(k) ?? 0) + by); }
  dec(labels: Labels = {}, by = 1): void { this.inc(labels, -by); }
  /** Gauges built from a query (per application, per status …) must not keep rows that disappeared. */
  reset(): void { this.#values.clear(); }
  get(labels: Labels = {}): number | undefined { return this.#values.get(keyOf(this.labelNames, labels)); }
  render(): string[] {
    return [...this.header(), ...[...this.#values].map(([k, v]) => `${this.name}${renderLabels(this.labelNames, k)} ${num(v)}`)];
  }
}

/** Seconds-oriented buckets: sub-second API work up to the minutes a chain confirmation can take. */
export const DEFAULT_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  #series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, labelNames: readonly string[] = [], readonly buckets: readonly number[] = DEFAULT_BUCKETS) {
    super(name, help, labelNames);
    if (buckets.some((b, i) => i > 0 && b <= buckets[i - 1]!)) throw new Error(`histogram buckets must ascend: ${name}`);
  }
  observe(value: number, labels: Labels = {}): void {
    const k = keyOf(this.labelNames, labels);
    const s = this.#series.get(k) ?? { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]! += 1;
    s.sum += value;
    s.count += 1;
    this.#series.set(k, s);
  }
  /** Times `fn` and records its duration in seconds regardless of outcome. */
  async time<T>(fn: () => Promise<T>, labels: Labels = {}): Promise<T> {
    const started = Date.now();
    try { return await fn(); } finally { this.observe((Date.now() - started) / 1000, labels); }
  }
  render(): string[] {
    const out = this.header();
    for (const [k, s] of this.#series) {
      for (let i = 0; i < this.buckets.length; i++) out.push(`${this.name}_bucket${renderLabels(this.labelNames, k, ['le', num(this.buckets[i]!)])} ${s.counts[i]}`);
      out.push(`${this.name}_bucket${renderLabels(this.labelNames, k, ['le', '+Inf'])} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(this.labelNames, k)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(this.labelNames, k)} ${s.count}`);
    }
    return out;
  }
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** A collector runs at scrape time to fill gauges that live outside the process (Postgres, the sponsor wallet). */
export type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  #metrics = new Map<string, Metric>();
  #collectors: Collector[] = [];

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter { return this.#add(new Counter(name, help, labelNames)); }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge { return this.#add(new Gauge(name, help, labelNames)); }
  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets?: readonly number[]): Histogram {
    return this.#add(new Histogram(name, help, labelNames, buckets));
  }
  #add<T extends Metric>(m: T): T {
    if (this.#metrics.has(m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.#metrics.set(m.name, m);
    return m;
  }
  /** Registered collectors run on every scrape; one failing collector must not blank the whole exposition. */
  onCollect(c: Collector): void { this.#collectors.push(c); }

  async collect(onError?: (e: unknown) => void): Promise<void> {
    for (const c of this.#collectors) {
      try { await c(); } catch (e) { onError?.(e); }
    }
  }
  async metrics(onError?: (e: unknown) => void): Promise<string> {
    await this.collect(onError);
    const lines: string[] = [];
    for (const m of this.#metrics.values()) lines.push(...m.render());
    return `${lines.join('\n')}\n`;
  }
}

/**
 * Prometheus samples are float64, so amounts are exposed in DUST rather than SPECK: 1e15 SPECK per DUST means a
 * SPECK count leaves the exact-integer range of a double at ~9 DUST, while the same value in DUST keeps ~15
 * significant digits — far more than any fee needs.
 */
export const specksToDustNumber = (specks: bigint): number => Number(specks) / 1e15;

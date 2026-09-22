import { describe, expect, it } from 'vitest';
import { MetricsRegistry, specksToDustNumber } from './metrics.js';
import { dustToSpecks } from './specks.js';

const lines = (text: string) => text.trim().split('\n');
const find = (text: string, prefix: string) => lines(text).filter((l) => l.startsWith(prefix));

describe('MetricsRegistry', () => {
  it('renders counters with HELP/TYPE headers and label sets', async () => {
    const r = new MetricsRegistry();
    const c = r.counter('aetherdust_test_total', 'a test counter', ['code']);
    c.inc({ code: 'OK' });
    c.inc({ code: 'OK' });
    c.inc({ code: 'RATE_LIMITED' }, 3);
    const out = await r.metrics();
    expect(lines(out)[0]).toBe('# HELP aetherdust_test_total a test counter');
    expect(lines(out)[1]).toBe('# TYPE aetherdust_test_total counter');
    expect(find(out, 'aetherdust_test_total{')).toEqual([
      'aetherdust_test_total{code="OK"} 2',
      'aetherdust_test_total{code="RATE_LIMITED"} 3',
    ]);
  });

  it('initialises a counter at zero so "never happened" is visible', async () => {
    const r = new MetricsRegistry();
    r.counter('aetherdust_outcomes_total', 'outcomes', ['outcome']).init({ outcome: 'failed' });
    expect(find(await r.metrics(), 'aetherdust_outcomes_total{')).toEqual(['aetherdust_outcomes_total{outcome="failed"} 0']);
  });

  it('escapes label values and help text', async () => {
    const r = new MetricsRegistry();
    r.counter('aetherdust_quoted_total', 'help with a \\ backslash', ['name']).inc({ name: 'a"b\\c' });
    const out = await r.metrics();
    expect(out).toContain('# HELP aetherdust_quoted_total help with a \\\\ backslash');
    expect(out).toContain('aetherdust_quoted_total{name="a\\"b\\\\c"} 1');
  });

  it('renders a metric with no labels', async () => {
    const r = new MetricsRegistry();
    r.gauge('aetherdust_plain', 'no labels').set(1.5);
    expect(find(await r.metrics(), 'aetherdust_plain ')).toEqual(['aetherdust_plain 1.5']);
  });

  it('gauge reset drops series that no longer exist', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge('aetherdust_apps', 'apps', ['application']);
    g.set(1, { application: 'a' });
    g.set(2, { application: 'b' });
    g.reset();
    g.set(5, { application: 'b' });
    expect(find(await r.metrics(), 'aetherdust_apps{')).toEqual(['aetherdust_apps{application="b"} 5']);
  });

  it('histogram buckets are cumulative and end at +Inf', async () => {
    const r = new MetricsRegistry();
    const h = r.histogram('aetherdust_latency_seconds', 'latency', [], [1, 5, 10]);
    h.observe(0.5); h.observe(4); h.observe(60);
    const out = await r.metrics();
    expect(find(out, 'aetherdust_latency_seconds_bucket')).toEqual([
      'aetherdust_latency_seconds_bucket{le="1"} 1',
      'aetherdust_latency_seconds_bucket{le="5"} 2',
      'aetherdust_latency_seconds_bucket{le="10"} 2',
      'aetherdust_latency_seconds_bucket{le="+Inf"} 3',
    ]);
    expect(find(out, 'aetherdust_latency_seconds_count')).toEqual(['aetherdust_latency_seconds_count 3']);
    expect(find(out, 'aetherdust_latency_seconds_sum')).toEqual(['aetherdust_latency_seconds_sum 64.5']);
  });

  it('rejects invalid names, duplicate registration and unordered buckets', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter('not a name', 'x')).toThrow(/invalid metric name/);
    r.counter('aetherdust_dup', 'x');
    expect(() => r.gauge('aetherdust_dup', 'x')).toThrow(/already registered/);
    expect(() => r.histogram('aetherdust_h', 'x', [], [5, 1])).toThrow(/ascend/);
  });

  it('runs collectors on every scrape and survives one that throws', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge('aetherdust_scrapes', 'scrapes');
    let n = 0;
    r.onCollect(() => { g.set(++n); });
    r.onCollect(() => { throw new Error('postgres is down'); });
    const errors: unknown[] = [];
    expect(find(await r.metrics((e) => errors.push(e)), 'aetherdust_scrapes ')).toEqual(['aetherdust_scrapes 1']);
    expect(find(await r.metrics((e) => errors.push(e)), 'aetherdust_scrapes ')).toEqual(['aetherdust_scrapes 2']);
    expect(errors).toHaveLength(2);
  });

  it('exposes DUST amounts with enough precision for real fees', () => {
    // the fee the sponsor actually paid on preprod (1 SPECK network fee + 1 µDUST overhead)
    expect(specksToDustNumber(dustToSpecks('0.000001000000001'))).toBeCloseTo(0.000001000000001, 18);
    expect(specksToDustNumber(dustToSpecks('5000'))).toBe(5000);
    expect(specksToDustNumber(0n)).toBe(0);
  });
});

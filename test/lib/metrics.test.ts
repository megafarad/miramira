import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '../../src/lib/metrics.js';

describe('createMetricsRegistry', () => {
  it('registers every named metric in the bundle', async () => {
    const m = createMetricsRegistry();
    const text = await m.registry.metrics();
    for (const name of [
      'http_requests_total',
      'http_request_duration_ms',
      'outbox_batch_claimed_total',
      'outbox_events_acked_total',
      'outbox_events_failed_total',
      'outbox_events_dead_total',
      'outbox_batch_duration_ms',
      'outbox_pending',
      'outbox_dead',
      'outbox_oldest_pending_age_ms',
      'fga_call_total',
      'fga_call_duration_ms',
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  it('includes default Node process metrics', async () => {
    const m = createMetricsRegistry();
    const text = await m.registry.metrics();
    // process_cpu_seconds_total and nodejs_eventloop_lag_seconds are part of
    // the default collector. Their presence proves collectDefaultMetrics ran.
    expect(text).toContain('process_cpu_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('http counter accepts method/route/status labels and increments', async () => {
    const m = createMetricsRegistry();
    m.httpRequestsTotal.inc({ method: 'GET', route: '/tenants/:id', status: '200' });
    m.httpRequestsTotal.inc({ method: 'GET', route: '/tenants/:id', status: '200' });
    const text = await m.registry.metrics();
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/tenants:id",status="200"\} 2|http_requests_total\{method="GET",route="\/tenants\/:id",status="200"\} 2/,
    );
  });

  it('fga counter accepts op/outcome labels', async () => {
    const m = createMetricsRegistry();
    m.fgaCallTotal.inc({ op: 'check', outcome: 'success' });
    m.fgaCallTotal.inc({ op: 'check', outcome: 'failure' });
    const text = await m.registry.metrics();
    expect(text).toContain('fga_call_total{op="check",outcome="success"} 1');
    expect(text).toContain('fga_call_total{op="check",outcome="failure"} 1');
  });
});

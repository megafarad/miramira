import { describe, expect, it } from 'vitest';
import { MetricsFgaClient } from '../../src/openfga/metrics-client.js';
import { createMetricsRegistry } from '../../src/lib/metrics.js';
import type { FgaClient } from '../../src/openfga/client.js';

function stubFga(overrides: Partial<FgaClient> = {}): FgaClient {
  return {
    writeTuples: async () => undefined,
    deleteTuples: async () => undefined,
    check: async () => true,
    listObjects: async () => [],
    readinessProbe: async () => ({ healthy: true, latencyMs: 0 }),
    ...overrides,
  };
}

describe('MetricsFgaClient', () => {
  it('records success outcome and timing on check', async () => {
    const metrics = createMetricsRegistry();
    const client = new MetricsFgaClient(stubFga({ check: async () => true }), metrics);
    const result = await client.check({ user: 'u:1', relation: 'r', object: 'o:1' });
    expect(result).toBe(true);
    const text = await metrics.registry.metrics();
    expect(text).toContain('fga_call_total{op="check",outcome="success"} 1');
    expect(text).toMatch(/fga_call_duration_ms_count\{op="check"\} 1/);
  });

  it('records failure outcome and propagates the error', async () => {
    const metrics = createMetricsRegistry();
    const boom = new Error('boom');
    const client = new MetricsFgaClient(
      stubFga({
        writeTuples: async () => {
          throw boom;
        },
      }),
      metrics,
    );
    await expect(client.writeTuples([])).rejects.toBe(boom);
    const text = await metrics.registry.metrics();
    expect(text).toContain('fga_call_total{op="write",outcome="failure"} 1');
  });

  it('passes arguments through unchanged and returns inner result', async () => {
    const metrics = createMetricsRegistry();
    let captured: { user: string } | null = null;
    const client = new MetricsFgaClient(
      stubFga({
        listObjects: async (input) => {
          captured = input;
          return ['o:1', 'o:2'];
        },
      }),
      metrics,
    );
    const out = await client.listObjects({ user: 'u:1', relation: 'r', type: 't' });
    expect(out).toEqual(['o:1', 'o:2']);
    expect(captured).toEqual({ user: 'u:1', relation: 'r', type: 't' });
  });

  it('instruments readinessProbe even though it self-times', async () => {
    const metrics = createMetricsRegistry();
    const client = new MetricsFgaClient(stubFga(), metrics);
    await client.readinessProbe();
    const text = await metrics.registry.metrics();
    expect(text).toContain('fga_call_total{op="readinessProbe",outcome="success"} 1');
  });
});

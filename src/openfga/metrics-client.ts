// Metrics-instrumented decorator around `FgaClient`.
//
// Implements the same interface so it can be dropped in upstream of any
// service that expects an FgaClient. Counts calls by op+outcome and records
// per-op latency. Errors propagate unchanged — instrumentation must never
// change behaviour.

import type { CheckInput, FgaClient, ListObjectsInput } from './client.js';
import type { TupleKey } from './tuples.js';
import type { Metrics } from '../lib/metrics.js';

type FgaOp = 'write' | 'delete' | 'check' | 'listObjects' | 'readinessProbe';

export class MetricsFgaClient implements FgaClient {
  constructor(
    private readonly inner: FgaClient,
    private readonly metrics: Pick<Metrics, 'fgaCallTotal' | 'fgaCallDurationMs'>,
  ) {}

  writeTuples(tuples: TupleKey[]): Promise<void> {
    return this.time('write', () => this.inner.writeTuples(tuples));
  }

  deleteTuples(tuples: TupleKey[]): Promise<void> {
    return this.time('delete', () => this.inner.deleteTuples(tuples));
  }

  check(input: CheckInput): Promise<boolean> {
    return this.time('check', () => this.inner.check(input));
  }

  listObjects(input: ListObjectsInput): Promise<string[]> {
    return this.time('listObjects', () => this.inner.listObjects(input));
  }

  readinessProbe(): Promise<{ healthy: boolean; latencyMs: number }> {
    // readinessProbe already self-times; we still wrap so it shows up in
    // fga_call_total. Its inner catch means we always see outcome=success.
    return this.time('readinessProbe', () => this.inner.readinessProbe());
  }

  private async time<T>(op: FgaOp, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.metrics.fgaCallTotal.inc({ op, outcome: 'success' });
      return result;
    } catch (err) {
      this.metrics.fgaCallTotal.inc({ op, outcome: 'failure' });
      throw err;
    } finally {
      this.metrics.fgaCallDurationMs.observe({ op }, Date.now() - start);
    }
  }
}

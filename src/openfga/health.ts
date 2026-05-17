import type { FgaClient } from './client.js';

export interface ReadinessResult {
  healthy: boolean;
  latencyMs: number;
}

export async function probeFga(fga: FgaClient): Promise<ReadinessResult> {
  return fga.readinessProbe();
}

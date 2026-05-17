import { OpenFgaClient as SdkClient } from '@openfga/sdk';
import type { TupleKey } from './tuples.js';

export interface CheckInput {
  user: string;
  relation: string;
  object: string;
}

export interface ListObjectsInput {
  user: string;
  relation: string;
  type: string;
}

export interface FgaClient {
  writeTuples(tuples: TupleKey[]): Promise<void>;
  deleteTuples(tuples: TupleKey[]): Promise<void>;
  check(input: CheckInput): Promise<boolean>;
  listObjects(input: ListObjectsInput): Promise<string[]>;
  readinessProbe(): Promise<{ healthy: boolean; latencyMs: number }>;
}

// OpenFGA's write endpoint caps batch size; chunking here keeps callers naive.
// 40 is the published default; lower to be safe across versions.
const WRITE_BATCH_SIZE = 25;

export class OpenFgaClientImpl implements FgaClient {
  constructor(private readonly sdk: SdkClient) {}

  async writeTuples(tuples: TupleKey[]): Promise<void> {
    if (tuples.length === 0) return;
    for (const batch of chunk(tuples, WRITE_BATCH_SIZE)) {
      await this.sdk.write({ writes: batch });
    }
  }

  async deleteTuples(tuples: TupleKey[]): Promise<void> {
    if (tuples.length === 0) return;
    for (const batch of chunk(tuples, WRITE_BATCH_SIZE)) {
      await this.sdk.write({ deletes: batch });
    }
  }

  async check(input: CheckInput): Promise<boolean> {
    const res = await this.sdk.check(input);
    return res.allowed === true;
  }

  async listObjects(input: ListObjectsInput): Promise<string[]> {
    const res = await this.sdk.listObjects(input);
    return res.objects ?? [];
  }

  async readinessProbe(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.sdk.readAuthorizationModel();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}

export interface CreateFgaClientInput {
  apiUrl: string;
  storeId: string;
  authorizationModelId: string;
}

/** Build a wired-up FgaClient from env-ish config. */
export function createFgaClient(input: CreateFgaClientInput): FgaClient {
  const sdk = new SdkClient({
    apiUrl: input.apiUrl,
    storeId: input.storeId,
    authorizationModelId: input.authorizationModelId,
  });
  return new OpenFgaClientImpl(sdk);
}

function* chunk<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}

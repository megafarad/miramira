import { OpenFgaClient as SdkClient } from '@openfga/sdk';
import { createFgaClient, type FgaClient } from '../../src/openfga/client.js';
import { AUTHORIZATION_MODEL } from '../../src/openfga/model.js';

const OPENFGA_API_URL = process.env.OPENFGA_API_URL ?? 'http://localhost:8080';

interface TestFgaContext {
  client: FgaClient;
  storeId: string;
  modelId: string;
  cleanup: () => Promise<void>;
}

export async function isFgaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OPENFGA_API_URL}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a fresh store + register the model, returning a wired-up FgaClient
 * and a cleanup function that deletes the store. Use beforeAll/afterAll.
 * Each test file gets its own store to avoid tuple pollution.
 */
export async function createTestFga(): Promise<TestFgaContext> {
  const tmp = new SdkClient({ apiUrl: OPENFGA_API_URL });
  const store = await tmp.createStore({ name: `miramira-test-${Date.now()}` });
  const storeId = store.id;

  const scoped = new SdkClient({ apiUrl: OPENFGA_API_URL, storeId });
  const model = await scoped.writeAuthorizationModel(AUTHORIZATION_MODEL);
  const modelId = model.authorization_model_id;

  const client = createFgaClient({
    apiUrl: OPENFGA_API_URL,
    storeId,
    authorizationModelId: modelId,
  });

  return {
    client,
    storeId,
    modelId,
    cleanup: async () => {
      await scoped.deleteStore();
    },
  };
}

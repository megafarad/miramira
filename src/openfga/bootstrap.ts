import { existsSync, appendFileSync } from 'node:fs';
import { OpenFgaClient as SdkClient } from '@openfga/sdk';
import { AUTHORIZATION_MODEL } from './model.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const apiUrl = process.env.OPENFGA_API_URL;
if (!apiUrl) {
  console.error('OPENFGA_API_URL is required.');
  process.exit(1);
}

const STORE_NAME = 'miramira';

async function main(): Promise<void> {
  // Step 1: store. Reuse if env points at an existing one; otherwise create.
  const existingStoreId = process.env.OPENFGA_STORE_ID;
  let storeId: string;

  if (existingStoreId) {
    const probe = new SdkClient({ apiUrl: apiUrl!, storeId: existingStoreId });
    try {
      await probe.getStore();
      storeId = existingStoreId;
      console.log(`Reusing existing store: ${storeId}`);
    } catch {
      console.error(
        `OPENFGA_STORE_ID=${existingStoreId} is set but the store was not found. ` +
          'Unset it to create a fresh store, or set it to a valid ID.',
      );
      process.exit(1);
    }
  } else {
    const tmp = new SdkClient({ apiUrl: apiUrl! });
    const created = await tmp.createStore({ name: STORE_NAME });
    storeId = created.id;
    console.log(`Created store: ${storeId}`);
  }

  // Step 2: register the current authorization model. Models are immutable in
  // OpenFGA — each write returns a new ID. The operator pins by setting
  // OPENFGA_AUTHORIZATION_MODEL_ID to the value printed below.
  const client = new SdkClient({ apiUrl: apiUrl!, storeId });
  const model = await client.writeAuthorizationModel(AUTHORIZATION_MODEL);
  const modelId = model.authorization_model_id;
  console.log(`Wrote authorization model: ${modelId}`);

  console.log('\nUpdate your .env with:');
  console.log(`  OPENFGA_STORE_ID=${storeId}`);
  console.log(`  OPENFGA_AUTHORIZATION_MODEL_ID=${modelId}`);

  // Machine-readable output for automated bootstrap. The Kubernetes
  // bootstrap Job sets BOOTSTRAP_OUTPUT_PATH, then reads this dotenv-format
  // file and patches the two IDs into a Secret consumed by the api/worker.
  // Manual/dev runs leave it unset and just copy from the log above.
  const outputPath = process.env.BOOTSTRAP_OUTPUT_PATH;
  if (outputPath) {
    appendFileSync(
      outputPath,
      `OPENFGA_STORE_ID=${storeId}\nOPENFGA_AUTHORIZATION_MODEL_ID=${modelId}\n`,
    );
    console.log(`\nWrote IDs to ${outputPath}`);
  }
}

main().catch((err: unknown) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

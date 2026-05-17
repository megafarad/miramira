import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    clearMocks: true,
    pool: 'forks',
    // Integration tests share a single Postgres database; serialize files
    // to avoid TRUNCATE races.
    fileParallelism: false,
  },
});

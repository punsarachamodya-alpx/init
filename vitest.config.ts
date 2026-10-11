import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    // Tests share one Postgres database; files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

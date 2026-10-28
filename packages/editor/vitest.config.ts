import { defineConfig } from 'vitest/config';
import { UNIT_TEST_MAX_WORKERS } from '../../scripts/lib/test-worker-budget.mjs';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // Match the app suite in local runs and CI; see the shared budget owner.
    maxWorkers: UNIT_TEST_MAX_WORKERS,
  },
});

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // Runner-specific tests stay out of the default Playwright suite: the
  // editor-embed harness has its own config, and Vitest unit files install a
  // matcher runtime that conflicts with Playwright's.
  testIgnore: ['**/editor-embed-bridge.spec.ts', '**/*.test.mjs'],
  timeout: isCI ? 90000 : 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [[isCI ? 'dot' : 'list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !!process.env.PLAYWRIGHT_REUSE_DEV_SERVER,
    timeout: isCI ? 90000 : 30000,
  },
});

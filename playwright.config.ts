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
  reporter: [
    [isCI ? 'dot' : 'list'],
    ['json', { outputFile: 'test-results/results.json' }],
    // open: 'never' so a local run never pops a browser tab; CI uploads the
    // folder as an artifact instead (see .gitlab-ci.yml).
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    // retries: 0 means 'on-first-retry' never fires — retain evidence for
    // every failure instead so a red CI run leaves a trace/video behind.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
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

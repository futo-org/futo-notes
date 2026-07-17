import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // The editor-embed bridge harness runs under its own no-dev-server config
  // (playwright.editor-embed.config.ts) which builds editor.html and loads it
  // over file://; keep it out of the dev-server-based runs.
  testIgnore: '**/editor-embed-bridge.spec.ts',
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

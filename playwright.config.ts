import { defineConfig, devices } from '@playwright/test';
import { webPort } from './scripts/lib/slot.mjs';

const isCI = !!process.env.CI;
const baseURL = `http://localhost:${webPort()}`;

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
    baseURL,
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
    // Desktop ships on WebKit, whose native selection-drag chromium cannot
    // reproduce. Local-only: CI installs chromium alone (.setup-playwright).
    ...(isCI
      ? []
      : [
          {
            name: 'webkit-pointer',
            use: { ...devices['Desktop Safari'] },
            testMatch: '**/editor-ux.spec.ts',
            // A tag, not a title: a rename must not silently empty the project.
            grep: /@webkit-pointer/,
          },
        ]),
  ],
  webServer: {
    command: 'pnpm run dev',
    url: baseURL,
    reuseExistingServer: !!process.env.PLAYWRIGHT_REUSE_DEV_SERVER,
    timeout: isCI ? 90000 : 30000,
  },
});

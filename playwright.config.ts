import { defineConfig, devices } from '@playwright/test';
import { webPort } from './scripts/lib/slot.mjs';

const isCI = !!process.env.CI;
const baseURL = `http://localhost:${webPort()}`;

// Sanitised: this becomes a path segment, so anything that could escape
// test-results/ is stripped rather than trusted.
const runId = (process.env.PW_RUN_ID ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);

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
  // Playwright WIPES outputDir at the start of every run, so a failing run's
  // trace, video and error-context.md are gone the moment you re-run to check
  // whether it was a flake — exactly when you need them (pc_fa46ccbcefea).
  // Set PW_RUN_ID to keep runs side by side:
  //   PW_RUN_ID=before pnpm exec playwright test tests/foo.spec.ts
  //   PW_RUN_ID=after  pnpm exec playwright test tests/foo.spec.ts
  // Unset (CI included) it stays 'test-results', so artifact paths are unchanged.
  outputDir: runId ? `test-results/${runId}` : 'test-results',
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

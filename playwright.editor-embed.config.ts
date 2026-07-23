import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the editor-embed futoBridge harness. Unlike the main
// web e2e config it needs NO dev server: globalSetup builds the single-file
// editor.html once and every test loads it over file://. Kept separate so the
// spec is never pulled into the dev-server-based `test:e2e:*` runs, which do
// not build the native editor bundle.

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testMatch: 'editor-embed-bridge.spec.ts',
  globalSetup: './tests/editorEmbedBundle.ts',
  timeout: isCI ? 90000 : 30000,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: 0,
  workers: 1,
  reporter: [
    [isCI ? 'dot' : 'list'],
    ['json', { outputFile: 'test-results/editor-embed-results.json' }],
    // open: 'never' so a local run never pops a browser tab; CI uploads the
    // folder as an artifact instead (see .gitlab-ci.yml).
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    hasTouch: true,
    // retries: 0 means 'on-first-retry' never fires — retain evidence for
    // every failure instead so a red CI run leaves a trace/video behind.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], hasTouch: true },
    },
  ],
});

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
  ],
  use: {
    hasTouch: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], hasTouch: true },
    },
  ],
});

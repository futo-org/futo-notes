import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the editor-embed futoBridge harness. Unlike the main
// web e2e config it needs NO dev server: globalSetup builds the single-file
// editor.html once and every test loads it over file://. Kept separate so the
// specs are never pulled into the dev-server-based `test:e2e:*` runs, which do
// not build the native editor bundle.
//
// The specs cover both editor engines the bundle ships while the Milkdown
// transition is in flight (docs/plan/milkdown-transition.md):
// `editor-embed-bridge` drives `editor.html?cm` (CodeMirror) and the
// `editor-embed-milkdown*` specs drive the bare URL (Milkdown), one per parity
// surface. `testMatch` takes the whole `editor-embed-*` family on purpose —
// naming the files one by one is how a new spec silently stops being run
// (AGENTS.md M11), and the root playwright config already excludes exactly this
// glob so the two configs cannot disagree about who owns a file.

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testMatch: /editor-embed-.+\.spec\.ts/,
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

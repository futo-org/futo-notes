import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the editor gauntlet.
//
// The gauntlet drives the single-file `editor.html` the native shells ship
// rather than the desktop app shell, so that it measures exactly the bytes
// that ship. That needs the same no-dev-server, build-the-bundle setup the
// editor-embed harness uses.
//
// Kept apart from playwright.editor-embed.config.ts because these runs are
// long: the perf floor opens a 10 MiB document and the foreign sweep can run
// for hours. Mixing them into the embed suite would make a contract suite that
// finishes in seconds look like it hangs.

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/editor-gauntlet',
  // Anchored to the FILE name: an unanchored `milkdown-` matches any checkout
  // whose directory is named after this work (…/futo-notes-milkdown-t3/…), and
  // then the whole gauntlet directory gets collected.
  testMatch: /[\\/]milkdown-[^\\/]*\.spec\.ts$/,
  globalSetup: './tests/editorEmbedBundle.ts',
  // Every spec sets its own budget with test.setTimeout; this is only a floor
  // for the fast ones.
  timeout: isCI ? 90_000 : 60_000,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: 0,
  workers: 1,
  reporter: [
    [isCI ? 'dot' : 'list'],
    ['json', { outputFile: 'test-results/editor-gauntlet-results.json' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    hasTouch: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], hasTouch: true } }],
});

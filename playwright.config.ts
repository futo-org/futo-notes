import { defineConfig, devices } from '@playwright/test';
import { webPort } from './scripts/lib/slot.mjs';
import { playwrightArtifacts } from './scripts/playwright-artifacts.mjs';

const isCI = !!process.env.CI;
const baseURL = `http://localhost:${webPort()}`;

const artifacts = playwrightArtifacts('desktop', 'results.json');

export default defineConfig({
  testDir: './tests',
  // Runner-specific tests stay out of the default Playwright suite: the
  // editor-embed harness has its own config, and Vitest unit files install a
  // matcher runtime that conflicts with Playwright's.
  testIgnore: [
    '**/editor-embed-*.spec.ts',
    '**/*.test.mjs',
    'editor-gauntlet/**/*.test.ts',
    // The gauntlet adapter drives the built editor.html bundle over file://,
    // so it runs under playwright.editor-gauntlet.config.ts (which builds that
    // bundle) rather than against this config's dev server.
    'editor-gauntlet/milkdown-*.spec.ts',
  ],
  timeout: isCI ? 90000 : 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  outputDir: artifacts.outputDir,
  reporter: [
    [isCI ? 'dot' : 'list'],
    ['json', { outputFile: artifacts.jsonReport }],
    // open: 'never' so a local run never pops a browser tab; CI uploads the
    // folder as an artifact instead (see .gitlab-ci.yml).
    ['html', { open: 'never', outputFolder: artifacts.htmlReport }],
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
  ],
  webServer: {
    command: 'pnpm run dev',
    // No file watcher: tests never need HMR, and on a shared CI host the
    // watches of several sharded dev servers exhausted the inotify limit
    // (vite.config.ts, server.watch).
    env: { FUTO_VITE_NO_WATCH: '1' },
    url: baseURL,
    reuseExistingServer: !!process.env.PLAYWRIGHT_REUSE_DEV_SERVER,
    timeout: isCI ? 90000 : 30000,
  },
});

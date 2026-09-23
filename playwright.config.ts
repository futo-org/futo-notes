import { defineConfig, devices } from '@playwright/test';
import { webPort } from './scripts/lib/slot.mjs';
import { gauntletArtifactCapture } from './tests/editor-gauntlet/artifactCapture';

const isCI = !!process.env.CI;
const baseURL = `http://localhost:${webPort()}`;
const artifactCapture = gauntletArtifactCapture();

// Sanitised: this becomes a path segment, so anything that could escape
// test-results/ is stripped rather than trusted.
const runId = (process.env.PW_RUN_ID ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
const evidenceDir = process.env.FUTO_VERIFICATION_DIR;
const reportRoot = evidenceDir ? `${evidenceDir}/playwright` : null;

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
  // Playwright WIPES outputDir at the start of every run, so a failing run's
  // trace, video and error-context.md are gone the moment you re-run to check
  // whether it was a flake — exactly when you need them (pc_fa46ccbcefea).
  // Set PW_RUN_ID to keep runs side by side:
  //   PW_RUN_ID=before pnpm exec playwright test tests/foo.spec.ts
  //   PW_RUN_ID=after  pnpm exec playwright test tests/foo.spec.ts
  // Unset (CI included) it stays 'test-results', so artifact paths are unchanged.
  outputDir: reportRoot
    ? `${reportRoot}/test-output`
    : runId
      ? `test-results/${runId}`
      : 'test-results',
  reporter: [
    [isCI ? 'dot' : 'list'],
    [
      'json',
      { outputFile: reportRoot ? `${reportRoot}/results.json` : 'test-results/results.json' },
    ],
    // open: 'never' so a local run never pops a browser tab; CI uploads the
    // folder as an artifact instead (see .gitlab-ci.yml).
    [
      'html',
      { open: 'never', outputFolder: reportRoot ? `${reportRoot}/report` : 'playwright-report' },
    ],
  ],
  use: {
    baseURL,
    // retries: 0 means 'on-first-retry' never fires — retain evidence for
    // every failure instead so a red CI run leaves a trace/video behind.
    trace: artifactCapture === 'off-retry-on-failure' ? 'off' : 'retain-on-failure',
    video: artifactCapture === 'off-retry-on-failure' ? 'off' : 'retain-on-failure',
    screenshot: artifactCapture === 'off-retry-on-failure' ? 'off' : 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // The `webkit-pointer` project is gone with the CodeMirror engine. It
    // existed for `editor-ux.spec.ts`, `editor-height-map.spec.ts` and
    // `table-controls-position.spec.ts`, all three of which asserted pointer
    // hit-testing that CodeMirror did itself (`interactions/**`, deleted in
    // ea65cf5a). A WYSIWYG editor leaves caret placement to the browser, so
    // there is no longer app code whose WebKit behaviour chromium cannot
    // reproduce. Re-add a project here the moment there is.
  ],
  webServer: {
    command: 'pnpm run dev',
    url: baseURL,
    reuseExistingServer: !!process.env.PLAYWRIGHT_REUSE_DEV_SERVER,
    timeout: isCI ? 90000 : 30000,
  },
});

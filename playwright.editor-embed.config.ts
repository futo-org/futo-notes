import { defineConfig, devices } from '@playwright/test';
import { playwrightArtifacts } from './scripts/playwright-artifacts.mjs';

// Dedicated config for the editor-embed futoBridge harness. Unlike the main
// web e2e config it needs NO dev server: globalSetup builds the single-file
// editor.html once and every test loads it over file://. Kept separate so the
// specs are never pulled into the dev-server-based `test:e2e:*` runs, which do
// not build the native editor bundle.
//
// The bundle ships ONE editor: the `editor-embed-milkdown*` specs drive it,
// one per surface (bridge contract, block drag, progressive open, toolbar,
// interactive keys, parity, wikilinks, compat canaries, deep nesting),
// `editor-embed-ime` covers what the editor tells the keyboard, and
// `editor-embed-webview-floor` holds the legacy-Android-WebView floor. They live here for the same reason: they need
// the built bundle over file://. `testMatch` takes the whole `editor-embed-*`
// family on purpose — naming the files one by one is how a new spec silently
// stops being run (AGENTS.md M11), and the root playwright config already
// excludes exactly this glob so the two configs cannot disagree about who owns
// a file.
// `editor-embed-milkdown-compat` is the one exception to "loads editor.html":
// it builds its own page (tests/milkdown-census/build.mjs), because its canaries
// have to run the UNPATCHED upstream preset alongside the shipping one and
// editor.html only contains the patched one.

const isCI = !!process.env.CI;
const artifacts = playwrightArtifacts('editor-embed', 'editor-embed-results.json');

export default defineConfig({
  testDir: './tests',
  testMatch: /editor-embed-.+\.spec\.ts/,
  globalSetup: './tests/editorEmbedBundle.ts',
  timeout: isCI ? 90000 : 30000,
  fullyParallel: false,
  forbidOnly: isCI,
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

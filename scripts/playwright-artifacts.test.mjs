import { expect, it, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightArtifacts } from './playwright-artifacts.mjs';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it('puts test output and both reporters inside the evidence run rather than shared overwrite paths', async () => {
  vi.stubEnv('FUTO_VERIFICATION_DIR', '/tmp/verification-fixture/run-one');
  const { default: config } = await import('../playwright.config.ts');
  expect(config.outputDir).toBe('/tmp/verification-fixture/run-one/playwright/test-output');
  expect(config.reporter).toContainEqual([
    'json',
    { outputFile: '/tmp/verification-fixture/run-one/playwright/results.json' },
  ]);
  expect(config.reporter).toContainEqual([
    'html',
    { open: 'never', outputFolder: '/tmp/verification-fixture/run-one/playwright/report' },
  ]);
});

it.each([
  ['desktop', 'results.json'],
  ['editor-embed', 'editor-embed-results.json'],
  ['editor-gauntlet', 'editor-gauntlet-results.json'],
])('keeps %s CI reports compatible and isolates named runs', (runner, filename) => {
  vi.stubEnv('FUTO_VERIFICATION_DIR', '');
  vi.stubEnv('PW_RUN_ID', '');
  const unnamed = playwrightArtifacts(runner, filename);
  expect(unnamed.jsonReport).toBe(`test-results/${filename}`);
  vi.stubEnv('PW_RUN_ID', '../../before');
  const named = playwrightArtifacts(runner, filename);
  expect(path.dirname(named.outputDir)).toBe(path.dirname(unnamed.outputDir));
  expect(named.outputDir).not.toBe(unnamed.outputDir);
  expect(named.jsonReport).toBe(`${named.outputDir}/results.json`);
  expect(path.dirname(named.htmlReport)).toBe(path.dirname(unnamed.htmlReport));
  vi.stubEnv('FUTO_VERIFICATION_DIR', '/tmp/run');
  const evidence = playwrightArtifacts(runner, filename);
  expect(evidence.outputDir).toBe(
    `/tmp/run/playwright${runner === 'desktop' ? '' : `/${runner}`}/test-output`,
  );
});

// Browser-backed cleanup regression. Opt in because ordinary unit-test hosts do
// not install Chromium. These probes use the real runner configs and reporters,
// replacing app setup/payload and relocating relative paths into scratch.
// PW_ARTIFACT_RETENTION_PROBE=1 just test-one scripts/playwright-artifacts.test.mjs --maxWorkers=2
it.skipIf(!process.env.PW_ARTIFACT_RETENTION_PROBE)(
  'retains screenshots, traces and reports across runners and run IDs',
  () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const scratch = path.join(root, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(path.join(scratch, 'playwright-retention-'));
    const configs = {
      desktop: 'playwright.config.ts',
      'editor-embed': 'playwright.editor-embed.config.ts',
      'editor-gauntlet': 'playwright.editor-gauntlet.config.ts',
    };
    const env = { ...process.env };
    delete env.PW_RUN_ID;
    delete env.FUTO_VERIFICATION_DIR;
    delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    delete env.PLAYWRIGHT_HTML_OUTPUT_DIR;
    const snapshots = new Map();
    const files = (parent) =>
      readdirSync(parent, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(parent, entry.name);
        return entry.isDirectory() ? files(file) : [file];
      });
    try {
      writeFileSync(
        path.join(dir, 'retention.spec.ts'),
        `
        import { test, expect } from '@playwright/test';
        test('artifact retention probe', async ({ page }, info) => {
          await page.setContent('<h1>' + process.env.PROBE_LABEL + '</h1>');
          await expect(page.locator('h1')).toHaveText(process.env.PROBE_LABEL!);
          const file = info.outputPath('evidence.png');
          await page.screenshot({ path: file });
          await info.attach('evidence', { path: file, contentType: 'image/png' });
        });
      `,
      );
      const run = (runner, overrides = {}) => {
        writeFileSync(
          path.join(dir, 'probe.config.ts'),
          `
          import original from ${JSON.stringify(path.join(root, configs[runner]))};
          import path from 'node:path';
          export default {
            ...original, testDir: '.', testMatch: 'retention.spec.ts', testIgnore: [],
            globalSetup: undefined, webServer: undefined,
            outputDir: path.resolve(${JSON.stringify(dir)}, original.outputDir ?? 'test-results'),
            use: { ...original.use, trace: 'on', video: 'off' },
          };
        `,
        );
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, 'node_modules/@playwright/test/cli.js'),
            'test',
            '--config',
            path.join(dir, 'probe.config.ts'),
            '--workers=1',
          ],
          {
            cwd: dir,
            env: { ...env, ...overrides, PROBE_LABEL: `${runner}-${snapshots.size}` },
            encoding: 'utf8',
            timeout: 30000,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        for (const [file, contents] of snapshots) {
          expect(readFileSync(file).equals(contents), `overwritten artifact: ${file}`).toBe(true);
        }
        const produced = files(dir).filter((file) =>
          /(?:evidence\.png|trace\.zip|results\.json|index\.html)$/.test(file),
        );
        const added = produced.filter((file) => !snapshots.has(file));
        for (const suffix of ['evidence.png', 'trace.zip', 'results.json', 'index.html']) {
          expect(
            added.some((file) => file.endsWith(suffix)),
            `missing ${suffix} for ${runner}`,
          ).toBe(true);
        }
        for (const file of produced) snapshots.set(file, readFileSync(file));
      };
      // Unnamed runs must not clear another runner, or earlier named runs.
      run('editor-embed', { PW_RUN_ID: 'before' });
      run('desktop', { PW_RUN_ID: 'before' });
      run('editor-embed', { PW_RUN_ID: 'after' });
      run('desktop', { PW_RUN_ID: 'after' });
      run('editor-embed');
      run('desktop');
      run('editor-gauntlet');
      // verify-run supplies one evidence directory to commands in the same run.
      const evidence = { FUTO_VERIFICATION_DIR: path.join(dir, 'verification') };
      run('desktop', evidence);
      run('editor-embed', evidence);
      run('editor-gauntlet', evidence);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  180000,
);

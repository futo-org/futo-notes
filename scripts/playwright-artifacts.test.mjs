import { expect, it, vi, afterEach } from 'vitest';
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

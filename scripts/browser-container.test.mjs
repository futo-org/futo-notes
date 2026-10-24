import { expect, it } from 'vitest';
import { browserContainerArgs } from './browser-container.mjs';

it('matches the installed Playwright revision and keeps all runtime state in the owned container/run', () => {
  const args = browserContainerArgs({
    root: '/checkout with spaces',
    version: '1.63.0',
    engine: 'webkit',
    runName: 'browser-container-abc',
    tests: ['tests/p0-regressions.spec.ts', '--grep', 'two words $(false)'],
  });
  expect(args).toContain('mcr.microsoft.com/playwright:v1.63.0-noble');
  expect(args).toContain('/checkout with spaces:/work:rw');
  expect(args).toContain('none');
  expect(args).toContain('--rm');
  expect(args).toContain('--userns=keep-id');
  expect(args).toContain('FUTO_BROWSER_ENGINE=webkit');
  expect(args).toContain('FUTO_VERIFICATION_DIR=/work/verification-runs/browser-container-abc');
  expect(args.slice(-4)).toEqual([
    'playwright.container.config.ts',
    'tests/p0-regressions.spec.ts',
    '--grep',
    'two words $(false)',
  ]);
});

it('rejects engines, versions and mount paths that cannot name the intended runtime', () => {
  const good = {
    root: '/checkout',
    version: '1.63.0',
    engine: 'webkit',
    runName: 'run',
    tests: [],
  };
  expect(() => browserContainerArgs({ ...good, engine: 'anything' })).toThrow('engine');
  expect(() => browserContainerArgs({ ...good, version: '^1.63.0' })).toThrow('version');
  expect(() => browserContainerArgs({ ...good, root: '/checkout:other' })).toThrow('colon');
  expect(() => browserContainerArgs({ ...good, runName: '../other' })).toThrow('run');
});

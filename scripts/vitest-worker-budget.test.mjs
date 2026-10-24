import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
afterEach(() => vi.unstubAllEnvs());

it.each([
  ['vitest.config.ts', ''],
  ['vitest.config.ts', '1'],
  ['packages/editor/vitest.config.ts', ''],
  ['packages/editor/vitest.config.ts', '1'],
])('bounds %s unit worker concurrency with CI=%j', async (config, ci) => {
  vi.stubEnv('CI', ci);
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    path.join(root, config),
  );
  expect(loaded.config.test.maxWorkers).toBe(4);
});

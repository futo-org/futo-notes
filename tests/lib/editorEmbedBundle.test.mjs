import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { build, loadConfigFromFile } = vi.hoisted(() => ({
  build: vi.fn(),
  loadConfigFromFile: vi.fn(),
}));
vi.mock('vite', () => ({ build, loadConfigFromFile }));
// The old setup must not run a real native build in this regression test.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const cleanups = [];
beforeEach(() => {
  loadConfigFromFile.mockResolvedValue({
    config: { plugins: [{ name: 'stage-native-editor-bundle' }], build: {} },
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

it('gives each run private editor bytes that survive a native output rebuild', async () => {
  vi.stubEnv('FUTO_EDITOR_EMBED_BUNDLE_PATH', undefined);
  loadConfigFromFile.mockResolvedValue({
    config: {
      plugins: [
        null,
        false,
        Promise.resolve([{ name: 'singlefile' }, { name: 'stage-native-editor-bundle' }]),
      ],
      build: { target: 'ES2020' },
    },
  });
  build.mockImplementation(async (config) => {
    fs.mkdirSync(config.build.outDir, { recursive: true });
    fs.writeFileSync(path.join(config.build.outDir, 'editor.html'), 'fresh editor');
  });
  const { default: setup } = await import('../editorEmbedBundle.ts');
  cleanups.push(await setup());
  const first = process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH;
  expect(first).toBeTruthy();
  expect(first).not.toContain('build/native-editor/');
  expect(fs.readFileSync(first, 'utf8')).toBe('fresh editor');
  cleanups.push(await setup());
  const second = process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH;
  expect(second).not.toBe(first);
  expect(fs.readFileSync(first, 'utf8')).toBe('fresh editor');
  expect(fs.readFileSync(second, 'utf8')).toBe('fresh editor');
  expect(build.mock.calls[0][0].plugins.map((plugin) => plugin.name)).toEqual(['singlefile']);
  expect(build.mock.calls[0][0].build.target).toBe('ES2020');
  // Workers get the run path from globalSetup's inherited environment.
  vi.resetModules();
  const worker = await import('../editorEmbedBundle.ts');
  expect(worker.EDITOR_BUNDLE_PATH).toBe(second);
  expect(worker.EDITOR_URL).toContain('editor.html?test');
});

it('cleans only its private output when a build fails', async () => {
  build.mockRejectedValue(new Error('bundle failed'));
  const before = fs.existsSync('build') ? fs.readdirSync('build') : [];
  const { default: setup } = await import('../editorEmbedBundle.ts');
  await expect(setup()).rejects.toThrow('bundle failed');
  expect(fs.readdirSync('build')).toEqual(before);
});

it('rejects a freshly built bundle that differs from a sweep snapshot', async () => {
  vi.stubEnv('FUTO_EDITOR_EMBED_EXPECTED_SHA256', '0'.repeat(64));
  build.mockImplementation(async (config) => {
    fs.mkdirSync(config.build.outDir, { recursive: true });
    fs.writeFileSync(path.join(config.build.outDir, 'editor.html'), 'changed build');
  });
  const { default: setup } = await import('../editorEmbedBundle.ts');
  await expect(setup()).rejects.toThrow(/bundle.*differs.*snapshot/i);
});

it.each([0, 2])('refuses a native config with %s staging plugins', async (count) => {
  loadConfigFromFile.mockResolvedValue({
    config: {
      plugins: Array.from({ length: count }, () => ({ name: 'stage-native-editor-bundle' })),
    },
  });
  const { default: setup } = await import('../editorEmbedBundle.ts');
  await expect(setup()).rejects.toThrow(/exactly one.*stage-native-editor-bundle/);
  expect(build).not.toHaveBeenCalled();
});

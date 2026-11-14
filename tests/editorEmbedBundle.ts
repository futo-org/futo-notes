import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PluginOption } from 'vite';

// Workers inherit the private path exported by globalSetup. Test discovery
// happens earlier but does not load the page. Per-run output keeps concurrent
// browser suites isolated; no test reads another build’s staging directory.
export const EDITOR_BUNDLE_PATH =
  process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH ??
  path.resolve(process.cwd(), 'build/native-editor/editor.html');
export const EDITOR_URL = `${pathToFileURL(EDITOR_BUNDLE_PATH).href}?test`;

async function testPlugins(options: PluginOption[] = []): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const option of options) {
    const plugin = await option;
    if (Array.isArray(plugin)) plugins.push(...(await testPlugins(plugin)));
    else if (plugin) plugins.push(plugin);
  }
  return plugins;
}

// Rebuild the standalone production bundle into private output for each run.
export default async function buildEditorEmbedBundle(): Promise<() => void> {
  const { build, loadConfigFromFile } = await import('vite');
  const root = process.cwd();
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.resolve(root, 'vite.editor.config.ts'),
  );
  if (!loaded) throw new Error('editor-embed harness: standalone Vite config was not loaded');
  mkdirSync(path.resolve(root, 'build'), { recursive: true });
  const outDir = mkdtempSync(path.resolve(root, 'build/editor-embed-'));
  const bundle = path.join(outDir, 'editor.html');
  const cleanup = () => rmSync(outDir, { recursive: true, force: true });
  try {
    const plugins = await testPlugins(loaded.config.plugins);
    await build({
      ...loaded.config,
      configFile: false,
      root,
      plugins,
      build: { ...loaded.config.build, outDir, emptyOutDir: true },
    });
    if (!existsSync(bundle)) {
      throw new Error(`editor-embed harness: bundle was not produced at ${bundle}`);
    }
    const expected = process.env.FUTO_EDITOR_EMBED_EXPECTED_SHA256;
    if (expected && createHash('sha256').update(readFileSync(bundle)).digest('hex') !== expected) {
      throw new Error('editor-embed harness: fresh bundle differs from the sweep snapshot');
    }
    process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH = bundle;
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

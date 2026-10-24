import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PluginOption } from 'vite';

// Workers inherit the private path exported by globalSetup. Test discovery
// happens earlier but does not load the page. Native builds may empty their
// staging output while a suite runs, so no running test reads that directory.
export const EDITOR_BUNDLE_PATH =
  process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH ??
  path.resolve(process.cwd(), 'build/native-editor/editor.html');
export const EDITOR_URL = `${pathToFileURL(EDITOR_BUNDLE_PATH).href}?test`;

async function testPlugins(options: PluginOption[] = []): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const option of options) {
    const plugin = await option;
    if (Array.isArray(plugin)) plugins.push(...(await testPlugins(plugin)));
    else if (plugin && plugin.name !== 'stage-native-editor-bundle') plugins.push(plugin);
  }
  return plugins;
}

// Rebuild the production single-file bundle for each run. Use the exact native
// config, with staging removed: tests neither overwrite native assets nor share
// output with native builds or another embed/gauntlet run.
export default async function buildEditorEmbedBundle(): Promise<() => void> {
  const { build, loadConfigFromFile } = await import('vite');
  const root = process.cwd();
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.resolve(root, 'vite.editor.config.ts'),
  );
  if (!loaded) throw new Error('editor-embed harness: native Vite config was not loaded');
  mkdirSync(path.resolve(root, 'build'), { recursive: true });
  const outDir = mkdtempSync(path.resolve(root, 'build/editor-embed-'));
  const bundle = path.join(outDir, 'editor.html');
  const cleanup = () => rmSync(outDir, { recursive: true, force: true });
  try {
    await build({
      ...loaded.config,
      configFile: false,
      root,
      plugins: await testPlugins(loaded.config.plugins),
      build: { ...loaded.config.build, outDir, emptyOutDir: true },
    });
    if (!existsSync(bundle)) {
      throw new Error(`editor-embed harness: bundle was not produced at ${bundle}`);
    }
    process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH = bundle;
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

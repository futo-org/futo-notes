/**
 * Building editor.html for a device run, outside the shipped path.
 *
 * `vite.editor.config.ts` is the one build of the native editor bundle, and
 * its staging plugin copies the result into the iOS resources and the Android
 * assets. A perf run sometimes needs a DIFFERENT bundle in the app — one with
 * inline source maps for attribution, or a historical build for a baseline —
 * so these helpers run the same config programmatically, with that plugin
 * removed, into their own output dir, and stage explicitly. The sourcemapped
 * bundle is never the staged one for longer than a run (M16): callers restore
 * the plain bundle afterwards (`buildEditorBundle` + `stageEditorBundle`).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const STAGED_EDITOR_TARGETS = [
  'apps/ios/Resources/editor.html',
  'apps/android/app/src/main/assets/editor.html',
];

/**
 * Builds editor.html with the editor config into `outDir` (repo-relative),
 * without staging. `sourcemap: 'inline'` embeds the map in the bundle, which
 * is what the attribution profiler resolves through.
 *
 * @returns the absolute path of the built bundle
 */
export async function buildEditorBundle({ root, outDir, sourcemap = false }) {
  const { build, loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(root, 'vite.editor.config.ts'),
  );
  const config = loaded.config;
  const plugins = (config.plugins ?? [])
    .flat()
    .filter((p) => p && p.name !== 'stage-native-editor-bundle');
  await build({
    ...config,
    configFile: false,
    root,
    logLevel: 'error',
    plugins,
    build: { ...config.build, sourcemap, outDir },
  });
  return path.join(root, outDir, 'editor.html');
}

/** Copies `bundle` over the two native shells' staged editor.html. */
export function stageEditorBundle(root, bundle) {
  for (const target of STAGED_EDITOR_TARGETS) {
    const output = path.join(root, target);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(bundle, output);
  }
}

/** Installs the debug app (direct flavor) with whatever is staged, onto $ANDROID_SERIAL. */
export function installDebugApp(root) {
  execFileSync(path.join(root, 'apps/android/gradlew'), [':app:installDirectDebug', '-q'], {
    cwd: path.join(root, 'apps/android'),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

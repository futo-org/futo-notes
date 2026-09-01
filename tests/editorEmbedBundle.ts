import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The single-file editor.html the native iOS/Android shells ship (built by
// `vite.editor.config.ts`, staged into the gitignored native asset dirs). The
// harness drives these exact bytes over `file://`.
export const EDITOR_BUNDLE_PATH = path.resolve(process.cwd(), 'build/native-editor/editor.html');
export const EDITOR_URL = `file://${EDITOR_BUNDLE_PATH}`;

// Playwright globalSetup: rebuild the bundle every run so a stale editor.html
// can never produce a false green. Mirrors the justfile's
// `node_modules/.bin/vite build --config vite.editor.config.ts`.
export default function buildEditorEmbedBundle(): void {
  execFileSync(
    path.resolve('node_modules/.bin/vite'),
    ['build', '--config', 'vite.editor.config.ts'],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  if (!existsSync(EDITOR_BUNDLE_PATH)) {
    throw new Error(`editor-embed harness: bundle was not produced at ${EDITOR_BUNDLE_PATH}`);
  }
}

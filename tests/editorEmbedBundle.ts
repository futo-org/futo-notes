import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The single-file editor.html the native iOS/Android shells ship (built by
// `vite.editor.config.ts`, staged into the gitignored native asset dirs). The
// harness drives these exact bytes over `file://`.
export const EDITOR_BUNDLE_PATH = path.resolve(process.cwd(), 'build/native-editor/editor.html');
export const EDITOR_URL = `file://${EDITOR_BUNDLE_PATH}`;

// The bundle ships TWO editor engines while the Milkdown transition is in
// flight (docs/plan/milkdown-transition.md): Milkdown is what a bare
// EDITOR_URL loads, and `?cm` selects the shipping CodeMirror live-preview
// editor (src/editor-embed/main.ts). A spec must say which engine it is
// asserting — the CodeMirror v7 contract suite reads CM6 DOM (`.cm-content`,
// marker reveal) and markdown-source output that a WYSIWYG engine has no
// equivalent for, so it pins itself to this URL rather than following
// whichever engine happens to be the default.
export const CM6_EDITOR_URL = `${EDITOR_URL}?cm`;

/** `?cm` on any bundle URL (used for the rewritten legacy-WebView copies). */
export function withCodeMirrorEngine(url: string): string {
  return `${url}?cm`;
}

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

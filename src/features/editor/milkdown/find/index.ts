/*
 * Find in note (docs/spec/editor.md, issue #26) — one engine, thin platform
 * bars.
 *
 * `findMatches.ts` is the arithmetic, `findPlugin.ts` the ProseMirror plugin,
 * `FindPanel.svelte` the desktop bar. The native shells render their own bars
 * and drive this same plugin through the futoBridge v8 calls
 * (`openFind`/`setFindQuery`/`stepFind`/`setFindOverlayInset`/`closeFind`),
 * reading the engine's `findMatches` report back — they never scan text,
 * compute a count, or decide a wrap.
 */
import { $prose } from '@milkdown/kit/utils';

import { createFindPlugin, type FindPluginOptions } from './findPlugin';

export { default as FindPanel } from './FindPanel.svelte';
export {
  FIND_CURRENT_CLASS,
  FIND_MATCH_CLASS,
  closeFind,
  findPluginKey,
  findSuppressesSelectionToolbar,
  getFindState,
  isFindOpen,
  openFind,
  setFindOverlayInset,
  setFindQuery,
  stepFind,
  type FindPluginState,
} from './findPlugin';
export { createFindMatchReport, type FindMatch, type FindMatchReport } from './findMatches';

/**
 * Whether this editor instance renders the WEB find bar.
 *
 * Desktop only. iOS and Android ship native find bars (NoteEditorView.swift,
 * NoteEditorScreen.kt) because a web panel is not native-quality mobile chrome
 * and because the bar has to dock above the soft keyboard, which the page
 * cannot see. Same gate and same reason as `resolveSelectionToolbar`; named
 * here because components never branch on platform (src/AGENTS.md).
 *
 * The ENGINE is mounted on every platform regardless — only the bar is gated.
 */
export function resolveFindPanel(nativeShell: boolean): 'enabled' | 'disabled' {
  return nativeShell ? 'disabled' : 'enabled';
}

/** The Milkdown plugin: `.use(findEngine({ onMatches }))`. */
export function findEngine(options: FindPluginOptions = {}) {
  return $prose(() => createFindPlugin(options));
}

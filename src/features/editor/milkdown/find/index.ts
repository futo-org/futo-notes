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
 * Everything a find bar renders — the whole of what the engine tells one.
 *
 * A bar owns no find logic: it shows this and calls back in. The desktop bar
 * (`FindPanel.svelte`, drawn by the shell's `NoteWorkspace.svelte`) and the two
 * native bars all work from exactly these five fields, and `label` is the
 * engine's own wording, never recomputed.
 */
export interface FindBarState {
  open: boolean;
  query: string;
  label: string;
  hasMatches: boolean;
  /** Changes on every open, including one that finds the bar already up. */
  focusToken: number;
}

/*
 * There is no `resolveFindPanel(nativeShell)` gate, deliberately. The web bar
 * is the DESKTOP SHELL's chrome — `NoteWorkspace.svelte` renders it, because it
 * spans the whole note pane rather than the editor column — and iOS and Android
 * mount `editor-embed/main.ts`, which has no shell chrome at all. The bar
 * therefore cannot reach a native host, without a runtime flag having to be
 * right. The ENGINE is mounted everywhere; only the bar is desktop-only.
 */

/** The Milkdown plugin: `.use(findEngine({ onMatches }))`. */
export function findEngine(options: FindPluginOptions = {}) {
  return $prose(() => createFindPlugin(options));
}

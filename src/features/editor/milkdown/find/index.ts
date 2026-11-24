/*
 * Find in note (docs/spec/editor.md, issue #26) — one engine, thin platform
 * bars.
 *
 * `findMatches.ts` is the arithmetic, `findPlugin.ts` the ProseMirror plugin.
 * The native shells render their own bars
 * and drive this same plugin through the futoBridge v8 calls
 * (`openFind`/`setFindQuery`/`stepFind`/`setFindOverlayInset`/`closeFind`),
 * reading the engine's `findMatches` report back — they never scan text,
 * compute a count, or decide a wrap.
 */
import { $prose } from '@milkdown/kit/utils';

import { createFindPlugin, type FindPluginOptions } from './findPlugin';

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
} from './findPlugin';
export { createFindMatchReport, type FindMatch, type FindMatchReport } from './findMatches';

/**
 * Everything a find bar renders — the whole of what the engine tells one.
 *
 * A bar owns no find logic: it shows this and calls back in. The desktop bar
 * (desktop/FindPanel.svelte, over the desktop editor's find) and the two
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

/** The Milkdown plugin: `.use(findEngine({ onMatches }))`. */
export function findEngine(options: FindPluginOptions = {}) {
  return $prose(() => createFindPlugin(options));
}

/*
 * Whether the offscreen-block containment stylesheet runs in this engine.
 *
 * The rule is `content-visibility: auto` + `contain-intrinsic-size: auto 24px`
 * on every top-level block (MilkdownEditor.svelte, docs/plan/
 * milkdown-transition.md §2/§5, issue #106): offscreen blocks skip rendering
 * work, which is what keeps keystroke cost from scaling with document length on
 * the low-end Android reference phone (tests/android-editor-perf.mjs).
 *
 * It cannot run on Apple's WebKit. There, a block that scrolls into view keeps
 * its box but paints NOTHING — a hole where a paragraph should be, which stays
 * blank while the view is still and fills in on some later scroll. Measured on
 * the iOS simulator on 2026-08-31 (a 40-paragraph note, ~350px of missing text
 * below the title for over a second) after the user reported text that
 * "appears to be gone and then mysteriously re-appears". It is a paint bug in
 * the UI-process compositor, not something the page can observe: the DOM
 * reports the blocks present, at full height, with `checkVisibility` calling
 * them visible, and it does not reproduce in Playwright's WebKit (whose
 * scrolling is not the async, tiled iOS one) or in Chromium.
 *
 * So the perf rule is engine-gated rather than dropped: Chromium — Android's
 * WebView and every desktop/web surface — keeps the containment and its
 * measured budgets, and Apple WebKit renders every block eagerly. Blank text is
 * not a trade worth making for a perf property (AGENTS.md M5 protects typing,
 * and typing into text you cannot see is not typing).
 *
 * Named here rather than read inline because `src/AGENTS.md` says components
 * never branch on platform — the same reason `blockDragMode.ts` exists.
 */
import { isAppleWebKit } from '$lib/platform';

export type BlockContainment =
  /** `content-visibility: auto` on offscreen blocks (Chromium). */
  | 'offscreen-skipped'
  /** Every block rendered eagerly (Apple WebKit — see the module doc). */
  | 'eager';

export function resolveBlockContainment(webkit: boolean = isAppleWebKit): BlockContainment {
  return webkit ? 'eager' : 'offscreen-skipped';
}

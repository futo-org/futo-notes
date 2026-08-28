/*
 * Which block-drag gesture this editor instance mounts.
 *
 * There are two, and they never coexist for one editor: a ⠿ gutter handle you
 * press and drag (`handleBlockDrag.ts`, on top of @milkdown/plugin-block), and
 * a Notion-style long press anywhere on the block, where the block itself is
 * the handle (`mobileBlockDnd.ts`). The long press is the native iOS shell's
 * gesture; everything else — desktop browser, Android, and the CodeMirror
 * editor, which has neither — gets the handle.
 *
 * The decision lives here rather than in the component because `src/AGENTS.md`
 * says components never branch on platform; the CodeMirror editor keeps its own
 * iOS reads in `createMarkdownEditorRuntime.ts` for the same reason. Having one
 * named answer instead of a boolean also means the component, the stylesheet
 * gutter, and the plugin choice cannot drift apart: they all read this.
 */
import { isIOS } from '$lib/platform';

export type BlockDragMode =
  /** ⠿ handle in the left gutter; mouse drag natively, touch/pen via handleBlockDrag.ts. */
  | 'gutter-handle'
  /** Long-press the block itself; iOS only. */
  | 'long-press';

/**
 * TEST-ONLY escape hatch: headless Chromium can never be sniffed as iOS, so the
 * long-press path needs a way in without a real device. `editor.html?forceMobileDnd`
 * or `window.__futoForceMobileDnd`; never set by production hosts, and the sole
 * extra input to the one gate below rather than a second ad-hoc platform check.
 */
function forcedByTest(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { __futoForceMobileDnd?: boolean }).__futoForceMobileDnd) return true;
  try {
    return new URLSearchParams(window.location.search).has('forceMobileDnd');
  } catch {
    return false;
  }
}

/** `nativeShell` is the embed host's own flag — the web app never long-presses. */
export function resolveBlockDragMode(nativeShell: boolean): BlockDragMode {
  return nativeShell && (isIOS || forcedByTest()) ? 'long-press' : 'gutter-handle';
}

/*
 * Which block-drag gesture this editor instance mounts.
 *
 * There are two, and they never coexist for one editor: a ⠿ gutter handle you
 * press and drag, which is @milkdown/plugin-block's own HTML5 drag, and a
 * Notion-style long press anywhere on the block, where the block itself is
 * the handle (`mobileBlockDnd.ts`). The long press is BOTH native shells'
 * gesture — iOS and Android alike; the pointer-precise desktop browser gets
 * the handle, and drags it with a mouse.
 *
 * The decision lives here rather than in the component because `src/AGENTS.md`
 * says components never branch on platform; the CodeMirror editor keeps its own
 * iOS reads in `createMarkdownEditorRuntime.ts` for the same reason. Having one
 * named answer instead of a boolean also means the component, the stylesheet
 * gutter, and the plugin choice cannot drift apart: they all read this.
 */

export type BlockDragMode =
  /** ⠿ handle in the left gutter, dragged with a mouse (@milkdown/plugin-block). */
  | 'gutter-handle'
  /** Long-press the block itself; the native shells' gesture. */
  | 'long-press';

const MODES: readonly BlockDragMode[] = ['gutter-handle', 'long-press'];

function asMode(value: string | null | undefined): BlockDragMode | null {
  return MODES.includes(value as BlockDragMode) ? (value as BlockDragMode) : null;
}

/**
 * TEST-ONLY escape hatch, and it must be able to force EITHER mode. The one
 * page a headless harness can load is `editor.html`, whose host flag is a
 * hard-coded `nativeShell: true`, so the long-press path is the only one a
 * Playwright run reaches by default. Its only current caller is this module's
 * own unit test: the e2e case that forced `gutter-handle` went away with the
 * handle's touch/pen drag on 2026-09-02, and the mouse drag it left behind has
 * no e2e coverage. `editor.html?blockDragMode=gutter-handle` (or
 * `=long-press`), or `window.__futoBlockDragMode`; never set by production
 * hosts, and the sole extra input to the one gate below rather than a second
 * ad-hoc platform check. An unrecognised value is ignored, not obeyed.
 */
function forcedByTest(): BlockDragMode | null {
  if (typeof window === 'undefined') return null;
  const flag = asMode((window as unknown as { __futoBlockDragMode?: string }).__futoBlockDragMode);
  if (flag) return flag;
  try {
    return asMode(new URLSearchParams(window.location.search).get('blockDragMode'));
  } catch {
    return null;
  }
}

/**
 * `nativeShell` is the embed host's own flag, and it is the whole gate: it is
 * true only in `src/editor-embed/main.ts`, which is what the iOS and Android
 * shells load in their WebView. The browser build never long-presses — a mouse
 * has the precision the handle wants, and a desktop long press means nothing.
 */
export function resolveBlockDragMode(nativeShell: boolean): BlockDragMode {
  return forcedByTest() ?? (nativeShell ? 'long-press' : 'gutter-handle');
}

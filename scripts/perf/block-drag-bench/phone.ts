/*
 * The phone page of `block-drag-bench.mjs --device android`: built INTO the
 * real editor.html bundle (the one the Android app's WebView loads), so the
 * benchmark runs against the embed's own mount, layout and stylesheet, and the
 * BlockDragSession it drives is the same module instance the long press uses.
 * The runner calls `window.__blockDragBench(plan)` over CDP.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import { BlockDragSession } from '$features/editor/milkdown/blockDragSession';
import { createBench, type BenchPlan } from './bench';

const bench = createBench({
  view: () =>
    (
      window as unknown as { __futoProseMirrorView?: () => EditorView | null }
    ).__futoProseMirrorView?.() ?? null,
  setContent: (noteId, text) =>
    (
      window as unknown as { FutoEditor: { setContent(id: string, text: string): void } }
    ).FutoEditor.setContent(noteId, text),
});

(window as unknown as { __blockDragBench: (plan: BenchPlan) => unknown }).__blockDragBench = (
  plan,
) => bench.runPlan(plan);

/** For ad-hoc probes of a live drag (`--eval`-style experiments over CDP). */
(window as unknown as { __blockDragBenchInternals: unknown }).__blockDragBenchInternals = {
  bench,
  BlockDragSession,
};

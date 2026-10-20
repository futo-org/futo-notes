import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { BlockDragSession } from './blockDragSession';

interface BlockDragSourceState {
  decorationSet: DecorationSet;
  /** Where a landing drop (`BlockDragSession.land`) will insert its block,
   * mapped through every transaction until it commits. */
  dropTarget?: number;
}

/** The session with a drop landing on each editor (`BlockDragSession.land`),
 * by editor DOM, so the editor's plugin can reach it. */
export const landingDrops = new WeakMap<HTMLElement, BlockDragSession>();

export const blockDragSourceKey = new PluginKey<BlockDragSourceState>('futo-block-drag-source');

/** Commits the drop landing on `view` now, if one is: whatever reads or saves
 * the note next (a host flush or `getContent`, the page going away) must find
 * the move in it, and a release whose slides are held up (an animation clock
 * stopped by the app going to the background) would otherwise leave it out. */
export function landPendingDrop(view: ProseView | null): void {
  if (view) landingDrops.get(view.dom)?.landed();
}

/** Whether a released drop is still landing on `view`: the note the host
 * would hear about now is the one before the move. */
export function dropLanding(view: ProseView | null): boolean {
  return view !== null && landingDrops.has(view.dom);
}

/** The Milkdown plugin behind the source-block dim: a plugin-state
 * `DecorationSet`, mapped through every transaction, that a session sets at
 * lift and clears at the end. WebKit's DOMObserver reverts a plain
 * `classList.add` on a node INSIDE the contenteditable (it "heals" the DOM back
 * to what ProseMirror's own render last produced), so the lifted block is dimmed
 * through a DECORATION, never a direct class mutation. Mounted once per editor
 * by `useBlockDragPlugins`, whichever gesture it got. */
export const blockDragSourcePlugin = $prose(
  () =>
    new Plugin<BlockDragSourceState>({
      key: blockDragSourceKey,
      state: {
        init: () => ({ decorationSet: DecorationSet.empty }),
        apply(tr, value) {
          const meta = tr.getMeta(blockDragSourceKey) as BlockDragSourceState | undefined;
          if (meta) return meta;
          if (!tr.docChanged) return value;
          return {
            decorationSet: value.decorationSet.map(tr.mapping, tr.doc),
            dropTarget:
              value.dropTarget === undefined ? undefined : tr.mapping.map(value.dropTarget),
          };
        },
      },
      props: {
        decorations(state) {
          return blockDragSourceKey.getState(state)?.decorationSet ?? null;
        },
      },
      // A drop still landing pictures the document before anything else
      // changed it: a change commits it now (or cancels it, when the change
      // took its block away), and the editor going away cancels it.
      view: (editorView) => ({
        update(view, prev) {
          if (view.state.doc !== prev.doc) landingDrops.get(view.dom)?.docChanged();
        },
        destroy() {
          landingDrops.get(editorView.dom)?.destroy();
        },
      }),
    }),
);

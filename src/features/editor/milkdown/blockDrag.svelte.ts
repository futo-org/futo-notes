/*
 * Block drag, both mechanisms read together: the desktop ⠿ gutter handle
 * (@milkdown/plugin-block's BlockProvider, fed a DOM node here) and the native
 * shells' long-press drag (`mobileBlockDnd.ts`), plus the one choice between
 * them. Which one an editor gets is `blockDragMode.ts`'s decision, read once
 * by MilkdownEditor.svelte (`useMobileBlockDnd`).
 *
 * What lives elsewhere: drop-target geometry (`blockDragGeometry.ts`), the
 * block move itself (`blockMove.ts`), the ⠿ handle's drop indicator and drop
 * (`blockDropIndicator.ts`; the drag mechanics themselves are
 * @milkdown/plugin-block's own HTML5 drag).
 */
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { block, BlockProvider } from '@milkdown/kit/plugin/block';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { blockDropIndicator } from './blockDropIndicator';
import {
  rememberSelectionBeforeHandlePress,
  settleSelectionAfterHandlePress,
} from './handlePressSelection';
import { retargetListDragToItem } from './listItemHandleDrag';
import { setDprCorrectedDragImage } from './blockDragGeometry';
import { createMobileBlockDndPlugin, type MobileBlockDndOptions } from './mobileBlockDnd';

/* The ⠿ handle lives in the editor's left GUTTER, 8px left of the text
 * column, whatever block is under the pointer. floating-ui's offset is
 * measured from the active block's own box, and a list item's box starts at
 * its text — its bullet or number hangs in the list's padding to the LEFT of
 * it — so a fixed offset put the handle squarely over the marker (reported:
 * "the grabber handle is rendering on top of the bullet"), and further right
 * still for a nested item, over the parent's text. Measuring the block's
 * inset from the text column and adding it back moves the handle out to the
 * gutter for every depth; the task checkbox now sits inside the list's own
 * box too (see `li[data-checked]` in milkdownEditor.css), so it needs no
 * special case. */
function blockHandleOffset(editorDom: HTMLElement, blockDom: HTMLElement): { mainAxis: number } {
  const contentLeft =
    editorDom.getBoundingClientRect().left + parseFloat(getComputedStyle(editorDom).paddingLeft);
  const inset = Math.max(0, blockDom.getBoundingClientRect().left - contentLeft);
  return { mainAxis: 4 + inset };
}

/** The handle's hit box, in px — matches `.milkdown-block-handle` in milkdownEditor.css. */
const BLOCK_HANDLE_HEIGHT_PX = 28;

/** Six dots, two columns of three: the grip glyph. An SVG rather than the
 * old `⠿` character, whose size and weight came from whatever font the
 * platform picked for braille. */
const BLOCK_HANDLE_GRIP_SVG =
  '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
  '<circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>' +
  '<circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
  '<circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';

/* What the handle lines up with: the block's FIRST LINE, not its middle.
 * floating-ui's `left` placement centres the handle on whatever box it is
 * given, and the block's own box put it halfway down a long paragraph, a
 * code block or a list — away from the line the block starts on, which is
 * where the eye looks for it. The first line is the first character's box;
 * a block with no text (an image, a divider) aligns to its top instead. */
function blockHandleAnchor(blockDom: HTMLElement): DOMRect {
  const box = blockDom.getBoundingClientRect();
  const walker = document.createTreeWalker(blockDom, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const text = walker.nextNode() as Text | null;
  if (text) {
    const range = document.createRange();
    const start = text.data.search(/\S/);
    range.setStart(text, start);
    range.setEnd(text, start + 1);
    const line = range.getClientRects()[0];
    // Park it outside the editor: a Range stays live until collected, and
    // one left in a block makes the next open rewrite DOM under it — the
    // WebKit O(n²) of tests/editor-open-large-paragraph.spec.ts.
    range.setEnd(document, 0);
    range.setStart(document, 0);
    if (line && line.height > 0) return new DOMRect(box.left, line.top, box.width, line.height);
  }
  if (box.height <= BLOCK_HANDLE_HEIGHT_PX) return box;
  return new DOMRect(box.left, box.top, box.width, BLOCK_HANDLE_HEIGHT_PX);
}

/**
 * Registers this editor's block-drag plugins on `builder`.
 *
 * THE single native-shell gate (see `useMobileBlockDnd` in
 * MilkdownEditor.svelte): the Notion-style long-press-anywhere-on-the-block
 * path REPLACES the ⠿ gutter handle plugin entirely for this editor instance
 * — the two never coexist.
 */
export function useBlockDragPlugins(
  builder: Editor,
  useMobileBlockDnd: boolean,
  mobile: MobileBlockDndOptions,
): Editor {
  return useMobileBlockDnd
    ? builder.use(createMobileBlockDndPlugin(mobile))
    : /* The handle's HTML5 drag needs a drop indicator, and it is OURS:
       * @milkdown/kit/plugin/cursor's draws two lines per gap
       * (blockDropIndicator.ts). Mounted with `block`, so it lives and dies
       * with the gesture it serves. */
      builder.use(block).use(blockDropIndicator);
}

/** One editor's desktop ⠿ gutter handle: its BlockProvider, the press on it, and the teardown. */
export function createBlockDrag(pmView: () => ProseView | null) {
  /* Notion-style block drag handle. BlockProvider (from Milkdown's block
   * plugin) owns rendering/positioning the ⠿ handle and the native HTML5 drag
   * mechanics; we just feed it a DOM node and, on touch where there is no
   * hover, nudge it to show for the block under the cursor/tap by dispatching a
   * synthetic pointermove — the SAME event the plugin's own hover detection
   * listens for, so selection/tap and mouse-hover resolve to identical block
   * boundaries. Dragging the handle is the block plugin's own HTML5 drag. */
  let blockProvider: BlockProvider | null = null;

  /* Drives the block plugin's own hover-detection path (BlockService listens
   * for `pointermove` on the ProseMirror DOM) so tap/selection reuse the exact
   * same block-boundary resolution as desktop mouse hover, instead of a
   * hand-rolled second implementation that could disagree with it. */
  function nudgeBlockHandle(clientY: number): void {
    const view = pmView();
    if (!view) return;
    const rect = view.dom.getBoundingClientRect();
    const evt = new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(evt);
  }

  /* Where a press on the ⠿ handle is, for the selection handback and for the
   * `handle-pressed` class that stops the plugin's NodeSelection painting as
   * selected text while the press lasts (handlePressSelection.ts). */
  let handlePress = $state<'idle' | 'pressed' | 'dragging'>('idle');

  function endHandlePress(): void {
    handlePress = 'idle';
    const view = pmView();
    if (view) settleSelectionAfterHandlePress(view);
  }

  /** A mouseup that did not start a drag — a click. A drag never gets here:
   * the engine swallows its mouseup, and `dragend` settles it instead. */
  function endHandleClick(): void {
    if (handlePress === 'pressed') endHandlePress();
  }

  /* The handle's position is only recomputed when the plugin shows/hides it;
   * without this it would visually drift over the wrong block while the user
   * scrolls, whichever element is carrying the scroll. */
  function handleBlockScroll(): void {
    blockProvider?.hide();
  }

  /** Builds the ⠿ handle for the editor `created` and hands it to BlockProvider. */
  function mountGutterHandle(created: Editor): void {
    const handleEl = document.createElement('div');
    handleEl.className = 'milkdown-block-handle';
    // A static string, no interpolation.
    handleEl.innerHTML = BLOCK_HANDLE_GRIP_SVG;
    handleEl.setAttribute('aria-hidden', 'true');
    blockProvider = new BlockProvider({
      ctx: created.ctx,
      content: handleEl,
      // `blockDom` in this context is the HANDLE element, not the block;
      // the block's own element is `active.el`.
      getOffset: ({ editorDom, active }) => blockHandleOffset(editorDom, active.el),
      getPosition: ({ active }) => blockHandleAnchor(active.el),
    });
    blockProvider.update();
    // The press never changes the user's selection (handlePressSelection.ts).
    // Registered BEFORE the provider's own listeners — `update()` only
    // attaches them on the next frame — so the selection remembered here
    // is the user's, not the NodeSelection the plugin is about to dispatch.
    handleEl.addEventListener('mousedown', () => {
      rememberSelectionBeforeHandlePress(created.ctx.get(editorViewCtx));
      handlePress = 'pressed';
      window.addEventListener('mouseup', endHandleClick, { once: true });
    });
    handleEl.addEventListener('dragstart', () => {
      handlePress = 'dragging';
      window.removeEventListener('mouseup', endHandleClick);
    });
    // `drop` normally comes first and has already carried the selection
    // through the move; the delay covers engines that fire `dragend` before
    // `drop` (the same guard @milkdown/plugin-block's own dragend uses),
    // where settling now would take the NodeSelection the drop still needs.
    handleEl.addEventListener('dragend', () => {
      window.setTimeout(endHandlePress, 50);
    });
    // AFTER the provider's own dragstart listener on the same element, so
    // the plugin's list selection exists to be re-targeted
    // (listItemHandleDrag.ts).
    handleEl.addEventListener('dragstart', (event) => {
      const view = created.ctx.get(editorViewCtx);
      const retargeted = retargetListDragToItem(view, event);
      // `retargetListDragToItem` already set a DPR-corrected ghost
      // (blockDragGeometry.ts, QA #012) for the list-item case; every
      // OTHER block drag still carries the plugin's own uncorrected
      // `setDragImage(activeEl, 0, 0)` from @milkdown/plugin-block, so it
      // needs the same correction here, read off whatever node the
      // plugin selected.
      if (!retargeted) {
        const selection = view.state.selection;
        const dom = selection instanceof NodeSelection ? view.nodeDOM(selection.from) : null;
        if (dom instanceof HTMLElement) setDprCorrectedDragImage(event, dom);
      }
    });
    // On `document`, in the CAPTURE phase, because scroll events do not
    // bubble and WHICH element scrolls depends on the host: the editable
    // itself in the embed, the shell's `.note-body` on desktop (see the
    // `.notes-shell` rule in milkdownEditor.css). Listening on the editable
    // alone left the handle floating over the wrong block for every desktop
    // scroll — and desktop is the only host that has a handle at all.
    document.addEventListener('scroll', handleBlockScroll, {
      passive: true,
      capture: true,
    });
  }

  /** Removes the handle and every listener `mountGutterHandle` added. */
  function destroy(): void {
    document.removeEventListener('scroll', handleBlockScroll, { capture: true });
    window.removeEventListener('mouseup', endHandleClick);
    blockProvider?.destroy();
    blockProvider = null;
  }

  return {
    get handlePress() {
      return handlePress;
    },
    nudgeBlockHandle,
    mountGutterHandle,
    destroy,
  };
}

import { EditorView, ViewPlugin } from '@codemirror/view';
import type { PluginValue, ViewUpdate } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { openSlashMenuEffect } from './slashMenu';
import { renderIcon } from './icons';

/**
 * Block gutter handle.
 *
 * Renders a floating handle in the left gutter area that follows the pointer as it
 * hovers over blocks. The handle has two buttons:
 *
 * - grip — starts an HTML5 drag; drop moves the block above/below the target block
 * - `+`  — inserts a blank line after the block and opens the slash menu
 *
 * Block detection walks up the syntax tree to the enclosing top-level markdown block.
 */

/** Syntax-tree node names that count as a "top-level block" we'll attach a handle to. */
const TOP_LEVEL_BLOCKS = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'Paragraph',
  'FencedCode',
  'CodeBlock',
  // ListItem comes before BulletList/OrderedList so `findEnclosingBlock` (which
  // walks up from the inner node) resolves each list item as its own block.
  // Without this, hovering anywhere inside a list anchors a single handle to
  // the whole list — there's no way to drag an individual item.
  'ListItem',
  'BulletList',
  'OrderedList',
  'Blockquote',
  'HorizontalRule',
  'Table',
]);

interface BlockRange {
  from: number;
  to: number;
  /** The syntax node name, for diagnostics/hiding rules */
  nodeName: string;
}

interface BlockRef {
  from: number;
  to: number;
}

/**
 * Pure function: compute the CM6-compatible change operation for moving `source`
 * before/after `target`. Returns null if the move is invalid (overlap or same block).
 *
 * Implementation strategy — compose the new full doc string, then emit a single
 * full-document replacement change. CM6's ChangeSet will still produce a minimal
 * diff internally, and this avoids the hairy arithmetic of composing overlapping
 * delete+insert operations.
 *
 * The invariant we maintain: any two blocks are separated by exactly `\n\n`, and
 * the doc has no leading/trailing blank lines as a result of the move.
 */
/**
 * Detect the prevailing newline separator style around a block in the original doc.
 * Checks both before and after the target block, returning the maximum found.
 * This way, a `\n\n`-separated doc stays double-spaced and a `\n`-separated doc
 * (common with headings) stays single-spaced.
 */
function detectSeparator(doc: string, block: BlockRef, _side: 'before' | 'after'): string {
  // Check after the block
  let afterNl = 0;
  for (let i = block.to; i < doc.length && doc[i] === '\n'; i++) afterNl++;
  // Check before the block
  let beforeNl = 0;
  for (let i = block.from - 1; i >= 0 && doc[i] === '\n'; i--) beforeNl++;
  // Use the max of both sides — if either neighbor has \n\n, keep that style
  const maxNl = Math.max(afterNl, beforeNl);
  return maxNl >= 2 ? '\n\n' : '\n';
}

export function computeBlockMove(
  doc: string,
  source: BlockRef,
  target: BlockRef,
  side: 'before' | 'after'
): { changes: Array<{ from: number; to: number; insert: string }> } | null {
  if (source.from === target.from && source.to === target.to) return null;
  // Overlap check — source contains target or vice versa
  if (source.from < target.to && target.from < source.to) return null;

  const sourceContent = doc.slice(source.from, source.to).replace(/^\n+|\n+$/g, '');

  // --- 1. Remove source along with surrounding newlines ---
  let delFrom = source.from;
  let delTo = source.to;
  // Prefer to absorb trailing newlines (separator sits after the block)
  while (delTo < doc.length && doc[delTo] === '\n') delTo++;
  // If source was at EOF (no trailing newlines to absorb), absorb preceding newlines
  if (delTo === source.to) {
    while (delFrom > 0 && doc[delFrom - 1] === '\n') delFrom--;
  }

  const withoutSource = doc.slice(0, delFrom) + doc.slice(delTo);

  // --- 2. Map target coords into the source-removed doc ---
  const deletedLen = delTo - delFrom;
  let tgtFrom = target.from;
  let tgtTo = target.to;
  if (delTo <= target.from) {
    tgtFrom -= deletedLen;
    tgtTo -= deletedLen;
  }

  // --- 3. Determine insertion point ---
  const insertPos = side === 'before' ? tgtFrom : tgtTo;

  // --- 4. Compose new doc, preserving original separator style ---
  // Look at what separator existed between the target block and its neighbor
  // in the ORIGINAL doc (before deletion). This preserves single-newline style
  // for heading→paragraph boundaries while keeping double-newline for para→para.
  const origSep = detectSeparator(doc, target, side);

  const before = withoutSource.slice(0, insertPos);
  const after = withoutSource.slice(insertPos);

  let prefix = '';
  let suffix = '';
  if (before.length > 0) {
    // Count existing trailing newlines
    let existingNl = 0;
    for (let i = before.length - 1; i >= 0 && before[i] === '\n'; i--) existingNl++;
    const needed = origSep.length;
    if (existingNl < needed) prefix = '\n'.repeat(needed - existingNl);
  }
  if (after.length > 0) {
    let existingNl = 0;
    for (let i = 0; i < after.length && after[i] === '\n'; i++) existingNl++;
    const needed = origSep.length;
    if (existingNl < needed) suffix = '\n'.repeat(needed - existingNl);
  }

  const newDoc = before + prefix + sourceContent + suffix + after;

  return {
    changes: [{ from: 0, to: doc.length, insert: newDoc }],
  };
}

/** Apply block-move changes to a plain string (helper for unit tests). */
export function applyBlockMove(
  doc: string,
  changes: Array<{ from: number; to: number; insert: string }>
): string {
  // Apply right-to-left so earlier offsets stay valid
  const sorted = [...changes].sort((a, b) => b.from - a.from);
  let result = doc;
  for (const op of sorted) {
    result = result.slice(0, op.from) + op.insert + result.slice(op.to);
  }
  return result;
}

function findEnclosingBlock(view: EditorView, pos: number): BlockRange | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (TOP_LEVEL_BLOCKS.has(node.name)) {
      return { from: node.from, to: node.to, nodeName: node.name };
    }
    node = node.parent;
  }
  // Fallback: treat the whole line as a "block"
  const line = view.state.doc.lineAt(pos);
  if (line.text.trim() === '') return null;
  return { from: line.from, to: line.to, nodeName: 'Line' };
}

const DRAG_MIME = 'application/x-sf-block';

class BlockHandleRenderer implements PluginValue {
  private handle: HTMLElement;
  private dropIndicator: HTMLElement;
  private grip: HTMLButtonElement;
  private add: HTMLButtonElement;
  /** The block currently anchored to the handle (for pointer hover) */
  private currentBlock: BlockRange | null = null;
  /** The block being dragged */
  private dragBlock: BlockRange | null = null;
  /** The target drop position */
  private dropTarget: { block: BlockRange; side: 'before' | 'after' } | null = null;

  constructor(private view: EditorView) {
    this.handle = document.createElement('div');
    this.handle.className = 'sf-block-handle';
    this.handle.contentEditable = 'false';

    this.grip = document.createElement('button');
    this.grip.type = 'button';
    this.grip.className = 'sf-block-handle__drag';
    this.grip.setAttribute('aria-label', 'Drag block');
    this.grip.draggable = true;
    this.grip.innerHTML = renderIcon('GripVertical');
    this.handle.appendChild(this.grip);

    this.add = document.createElement('button');
    this.add.type = 'button';
    this.add.className = 'sf-block-handle__add';
    this.add.setAttribute('aria-label', 'Insert block below');
    this.add.innerHTML = renderIcon('Plus');
    this.handle.appendChild(this.add);

    this.dropIndicator = document.createElement('div');
    this.dropIndicator.className = 'sf-block-drop-indicator';
    this.dropIndicator.style.display = 'none';

    // Append to document body with fixed positioning — avoids clipping by
    // ancestor containers with overflow rules.
    document.body.appendChild(this.handle);
    document.body.appendChild(this.dropIndicator);

    this.bindHandleEvents();
    this.bindEditorEvents();
  }

  private bindHandleEvents(): void {
    // Prevent clicks from stealing editor focus
    this.handle.addEventListener('mousedown', (e) => {
      if (e.target !== this.grip && !this.grip.contains(e.target as Node)) {
        e.preventDefault();
      }
    });

    this.add.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this.currentBlock) return;
      this.insertBlockAfter(this.currentBlock);
    });

    this.grip.addEventListener('dragstart', (e) => {
      if (!this.currentBlock) {
        e.preventDefault();
        return;
      }
      this.dragBlock = this.currentBlock;
      this.view.dom.setAttribute('data-block-dragging', 'true');
      // Only the custom MIME — NEVER `text/plain`. CM6's content DOM has its own
      // drop listener that would paste `text/plain` as a text insert, causing a
      // duplicate of the block.
      e.dataTransfer?.setData(DRAG_MIME, '1');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      // Transparent drag image so the OS doesn't render a rogue thumbnail.
      const ghost = document.createElement('div');
      ghost.style.width = '1px';
      ghost.style.height = '1px';
      ghost.style.opacity = '0';
      document.body.appendChild(ghost);
      e.dataTransfer?.setDragImage(ghost, 0, 0);
      // Clean up the ghost on the next frame
      requestAnimationFrame(() => ghost.remove());
    });

    this.grip.addEventListener('dragend', () => {
      this.view.dom.removeAttribute('data-block-dragging');
      this.dragBlock = null;
      this.dropTarget = null;
      this.dropIndicator.style.display = 'none';
    });
  }

  private hideTimer: number | null = null;

  private scheduleHide(): void {
    if (this.hideTimer != null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (!this.dragBlock) this.hide();
    }, 250);
  }

  private cancelHide(): void {
    if (this.hideTimer != null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private bindEditorEvents(): void {
    const scroll = this.view.scrollDOM;

    // Track pointer movement across the whole document so the handle shows up
    // while the cursor is in the left gutter (where the handle itself sits) —
    // otherwise the user has to detour onto the text to summon it and back.
    // clientX is clamped into the content column before resolving to a block.
    const onDocPointerMove = (e: PointerEvent) => {
      if (this.dragBlock) return;
      const contentRect = this.view.contentDOM.getBoundingClientRect();
      const scrollRect = this.view.scrollDOM.getBoundingClientRect();
      // Active area: from ~80px left of content (gutter where the handle lives)
      // through the scroll container's right edge, vertically bounded by scrollDOM.
      const gutterLeft = contentRect.left - 80;
      const inActiveArea =
        e.clientX >= gutterLeft &&
        e.clientX <= scrollRect.right &&
        e.clientY >= scrollRect.top &&
        e.clientY <= scrollRect.bottom;
      if (!inActiveArea) {
        this.scheduleHide();
        return;
      }
      const x = Math.max(contentRect.left + 1, Math.min(contentRect.right - 1, e.clientX));
      this.cancelHide();
      this.updateHandleForPointer(x, e.clientY);
    };
    document.addEventListener('pointermove', onDocPointerMove);
    this.pointerListener = onDocPointerMove;

    scroll.addEventListener('pointerleave', () => {
      if (!this.dragBlock) this.scheduleHide();
    });

    // Keep the handle visible while the pointer is over it
    this.handle.addEventListener('pointerenter', () => this.cancelHide());
    this.handle.addEventListener('pointerleave', () => {
      if (!this.dragBlock) this.scheduleHide();
    });

    // Register dragover/drop on CM6's contentDOM *in the capture phase*. CM6
    // installs its own drop handler there (which pastes `text/plain`); if we
    // let it run, the moved block ends up duplicated. Capture + preventDefault
    // short-circuits CM6's handler before it executes.
    //
    // Also register on `document` so a drag that goes straight up/down from the
    // handle (which sits in the left gutter, outside scrollDOM) still produces
    // drop-target updates — we clamp clientX into the content column.
    const content = this.view.contentDOM;
    const onDragOver = (e: DragEvent) => {
      if (!this.dragBlock) return;
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const contentRect = this.view.contentDOM.getBoundingClientRect();
      const x = Math.max(contentRect.left + 1, Math.min(contentRect.right - 1, e.clientX));
      this.updateDropTarget(x, e.clientY);
    };
    const onDrop = (e: DragEvent) => {
      if (!this.dragBlock) return;
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      this.commitDrop();
    };
    content.addEventListener('dragover', onDragOver, true);
    content.addEventListener('drop', onDrop, true);
    // ScrollDOM catches drops outside the text box but inside the scroller
    scroll.addEventListener('dragover', onDragOver, true);
    scroll.addEventListener('drop', onDrop, true);
    // Document catches drags in the left gutter / anywhere in the viewport
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    this.documentListeners = { onDragOver, onDrop };
  }

  private documentListeners: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void } | null = null;
  private pointerListener: ((e: PointerEvent) => void) | null = null;

  update(update: ViewUpdate): void {
    // Doc edits may have invalidated current block's range — re-resolve by re-running
    // the hover lookup next pointermove. In the meantime, clear stale state.
    if (update.docChanged && this.currentBlock) {
      this.currentBlock = {
        from: update.changes.mapPos(this.currentBlock.from, -1),
        to: update.changes.mapPos(this.currentBlock.to, 1),
        nodeName: this.currentBlock.nodeName,
      };
      const block = this.currentBlock;
      // Reading layout during update() is illegal in CM6 — defer.
      this.view.requestMeasure({
        read: () => this.lineGeometryAt(block.from),
        write: (coords) => this.applyHandlePosition(coords),
      });
    }
  }

  private updateHandleForPointer(clientX: number, clientY: number): void {
    const pos = this.view.posAtCoords({ x: clientX, y: clientY });
    if (pos == null) {
      this.hide();
      return;
    }
    const block = findEnclosingBlock(this.view, pos);
    if (!block) {
      this.hide();
      return;
    }
    // Skip inside tables — the table editor owns its own chrome
    if (block.nodeName === 'Table') {
      this.hide();
      return;
    }
    this.currentBlock = block;
    this.positionHandleFor(block);
    this.handle.classList.add('sf-block-handle--visible');
  }

  private positionHandleFor(block: BlockRange): void {
    this.applyHandlePosition(this.lineGeometryAt(block.from));
  }

  /**
   * True viewport-relative top/bottom for the line containing `pos`.
   *
   * `coordsAtPos` is unreliable here: when the line starts with a widget-replaced
   * range (e.g. `- [ ] ` becomes a checkbox widget), it returns a 1px-tall rect at
   * the widget's baseline instead of the line's actual extent. That throws off both
   * handle centering and the drop indicator. `lineBlockAt` gives the real line
   * geometry in content coords, which we convert to viewport using contentDOM's rect.
   */
  private lineGeometryAt(pos: number): { top: number; bottom: number; left: number } | null {
    const lineBlock = this.view.lineBlockAt(pos);
    const contentRect = this.view.contentDOM.getBoundingClientRect();
    // Derive x from coordsAtPos — it's accurate even when height is collapsed.
    const c = this.view.coordsAtPos(pos, 1);
    const left = c ? c.left : contentRect.left;
    return {
      top: contentRect.top + lineBlock.top,
      bottom: contentRect.top + lineBlock.bottom,
      left,
    };
  }

  private applyHandlePosition(coords: { top: number; bottom: number; left: number } | null): void {
    if (!coords) return;
    // Fixed-positioned handle uses viewport coords directly. Vertically center on
    // the first line of the block (so headings with tall line-height don't push
    // the handle above the glyphs). Horizontally, anchor by the handle's right
    // edge so the handle stays fully outside the content column.
    const contentRect = this.view.contentDOM.getBoundingClientRect();
    const handleWidth = this.handle.offsetWidth || 56;
    const handleHeight = this.handle.offsetHeight || 26;
    const lineCenter = (coords.top + coords.bottom) / 2;
    const top = lineCenter - handleHeight / 2;
    const left = contentRect.left - handleWidth - 4;
    this.handle.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }

  private hide(): void {
    this.handle.classList.remove('sf-block-handle--visible');
    this.currentBlock = null;
  }

  private updateDropTarget(clientX: number, clientY: number): void {
    const pos = this.view.posAtCoords({ x: clientX, y: clientY });
    if (pos == null) return;
    const block = findEnclosingBlock(this.view, pos);
    if (!block) return;
    if (!this.dragBlock) return;
    // Don't target the block we're dragging
    if (block.from === this.dragBlock.from && block.to === this.dragBlock.to) {
      this.dropIndicator.style.display = 'none';
      return;
    }
    // Use lineBlockAt for accurate top/bottom — block.to may sit on the last line
    // of a multi-line block, and coordsAtPos at widget-replaced positions gives a
    // 1px-tall rect at the widget's baseline (would land the indicator inside the row).
    const topGeom = this.lineGeometryAt(block.from);
    const bottomGeom = this.lineGeometryAt(Math.max(block.from, block.to - 1));
    if (!topGeom || !bottomGeom) return;
    const mid = (topGeom.top + bottomGeom.bottom) / 2;
    const side: 'before' | 'after' = clientY < mid ? 'before' : 'after';
    this.dropTarget = { block, side };

    // Fixed-positioned indicator uses viewport coords directly
    const content = this.view.contentDOM.getBoundingClientRect();
    const indicatorTop = side === 'before' ? topGeom.top : bottomGeom.bottom;
    this.dropIndicator.style.top = `${indicatorTop - 1}px`;
    this.dropIndicator.style.left = `${content.left}px`;
    this.dropIndicator.style.width = `${content.width}px`;
    this.dropIndicator.style.display = '';
  }

  private commitDrop(): void {
    if (!this.dragBlock || !this.dropTarget) return;
    const move = computeBlockMove(
      this.view.state.doc.toString(),
      this.dragBlock,
      this.dropTarget.block,
      this.dropTarget.side
    );
    this.dropIndicator.style.display = 'none';
    this.dragBlock = null;
    this.dropTarget = null;
    if (!move) return;
    this.view.dispatch({
      changes: move.changes,
      userEvent: 'move.block',
    });
  }

  private insertBlockAfter(block: BlockRange): void {
    // Insert a blank line after the block, put cursor there, open slash menu
    const state = this.view.state;
    const insertPos = block.to;
    const needsLeadingNewline = insertPos > 0 && state.sliceDoc(insertPos - 1, insertPos) !== '\n';
    const afterChar = insertPos < state.doc.length ? state.sliceDoc(insertPos, insertPos + 1) : '';
    const needsTrailingNewline = afterChar !== '\n' && afterChar !== '';

    let insert = '';
    if (needsLeadingNewline) insert += '\n';
    insert += '\n';
    const cursorOffset = insert.length;
    if (needsTrailingNewline) insert += '\n';

    this.view.dispatch({
      changes: { from: insertPos, insert },
      selection: EditorSelection.cursor(insertPos + cursorOffset),
    });

    // Open slash menu at the caret position (we insert the `/` ourselves so the query
    // scaffolding starts at a known position)
    const slashPos = insertPos + cursorOffset;
    this.view.dispatch({
      changes: { from: slashPos, insert: '/' },
      selection: EditorSelection.cursor(slashPos + 1),
      effects: openSlashMenuEffect.of({ from: slashPos }),
    });

    this.view.focus();
  }

  destroy(): void {
    this.handle.remove();
    this.dropIndicator.remove();
    if (this.documentListeners) {
      document.removeEventListener('dragover', this.documentListeners.onDragOver, true);
      document.removeEventListener('drop', this.documentListeners.onDrop, true);
      this.documentListeners = null;
    }
    if (this.pointerListener) {
      document.removeEventListener('pointermove', this.pointerListener);
      this.pointerListener = null;
    }
  }
}

export const blockHandle = ViewPlugin.fromClass(BlockHandleRenderer);

/** Exported for unit tests */
export const __test = { findEnclosingBlock, TOP_LEVEL_BLOCKS };

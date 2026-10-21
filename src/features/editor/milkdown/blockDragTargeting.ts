import { targetAtPointerY, type DropTarget } from './blockDragGeometry';
import { isNoOpDrop, type BlockMoveRange } from './blockMove';
import { blockDragSourceKey } from './blockDragSource';
import type { BlockDragLift, BlockDragSessionOptions } from './blockDragSession';
import { BlockDragVisuals } from './blockDragVisuals';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/** Where a drag would drop: the gap under the pointer, the lifted block's current
 * range, and keeping the drop line and its boundary ticks in step with both. */
export abstract class BlockDragTargeting extends BlockDragVisuals {
  protected lastY = 0;

  /** The boundary the indicator is currently drawn at. `pos` IS the boundary's
   * whole identity (blockDragGeometry.ts), so only a CHANGE of this fires
   * `onBoundaryChange`: a finger traveling inside one gap is silent, and
   * crossing from one block's lower half into the next block's upper half — the
   * same gap — is silent too, because the bar did not move. */
  protected indicatorPos: number | null = null;

  protected readonly options: BlockDragSessionOptions;

  protected constructor(view: ProseView, options: BlockDragSessionOptions) {
    super(view);
    this.options = options;
  }

  /** Redraws the drop indicator for `clientY`, notifying once per NEW boundary
   * when `tick` is true.
   *
   * Auto-scroll passes false. The finger is holding still while the document
   * sweeps past underneath it, and at auto-scroll speeds that is hundreds of
   * boundaries a second: a tick each would be one continuous buzz, and would
   * destroy the meaning of the tick, which is "you have put the bar somewhere
   * new". The spec already says a hold ticks nothing, and an auto-scroll IS a
   * hold. The key is still updated, so the first tick after the finger resumes
   * moving belongs to a genuinely new boundary rather than to one the eye
   * already saw slide by. */
  protected syncIndicator(clientY: number, tick: boolean): void {
    if (this.reflow) {
      // False once the doc changed shape under the drag: the preview ended
      // itself, and the line takes over from the next move.
      if (!this.reflow.sync(clientY, tick)) this.reflow = null;
      return;
    }
    const target = this.computeTarget(clientY);
    if (!target || this.isNoOpTarget(target)) {
      // A no-op target (either of the lifted block's own two boundaries, or
      // nowhere resolvable) draws no line: `indicatorPos` is cleared rather
      // than left pointing at the no-op boundary, so the first tick after the
      // finger leaves this zone always belongs to the first genuinely new
      // boundary it reaches — never a spurious one for re-entering here, and
      // never one for the two no-op boundaries between each other.
      this.hideIndicator();
      this.indicatorPos = null;
      return;
    }
    this.showIndicator(target);
    if (target.pos === this.indicatorPos) return;
    this.indicatorPos = target.pos;
    if (tick) this.options.onBoundaryChange?.();
  }

  /** True when `target` is a no-op for the block currently lifted — i.e. one
   * of its own two boundaries (`isNoOpDrop`, shared with `moveBlock`). Guards
   * the indicator/haptic layer here; a release over a no-op target was already
   * a silent no-op via `moveBlock`, this only stops the line being drawn (and
   * the card overlapping it) while the pointer is still over the block it just
   * picked up. */
  protected isNoOpTarget(target: DropTarget): boolean {
    const range = this.lifted && this.currentSourceRange(this.lifted);
    return range ? isNoOpDrop(range, target.pos) : false;
  }

  /** After every frame edge auto-scroll actually moved the scroller. The
   * pointer has not moved, so the ghost stays put — but the boundary UNDER it
   * has changed, and the indicator (and the position a release would commit to)
   * must be recomputed from the new geometry rather than assumed. */
  protected onAutoScrollStep = (): void => {
    if (!this.lifted) return;
    this.syncIndicator(this.lastY, false);
  };

  /** The top-level gap under `clientY`, or null once the lifted block is gone
   * from the document. `release`: this is the gap a release commits to (see
   * `ReflowCurtain.release`). */
  protected computeTarget(clientY: number, release = false): DropTarget | null {
    if (!this.lifted) return null;
    if (this.reflow) {
      // The doc was replaced under the drag: the preview has ended itself, and
      // the line geometry (or no drop at all, if the source is gone) takes over.
      if (this.reflow.ensureValid()) {
        return release ? this.reflow.release(clientY) : this.reflow.target(clientY);
      }
      this.reflow = null;
    }
    return this.currentSourceRange(this.lifted) ? targetAtPointerY(this.view, clientY) : null;
  }

  /** The source block's CURRENT range. The decoration set is mapped through
   * every transaction (see the plugin's `apply`), so this survives anything
   * that edited the doc between the lift and release — autocorrect, a host
   * `setContent`, the trailing-paragraph plugin. The lift-time positions are
   * only the fallback. */
  protected currentSourceRange(lifted: BlockDragLift): BlockMoveRange | null {
    const decorations = blockDragSourceKey.getState(this.view.state)?.decorationSet;
    const found = decorations?.find(
      undefined,
      undefined,
      (spec: { futoDragSource?: boolean }) => spec.futoDragSource === true,
    );
    if (found && found.length === 1) return { from: found[0].from, to: found[0].to };
    // The lift-time range is only good while that exact block is still there:
    // a replaced document leaves it pointing past the end, or into other text.
    const doc = this.view.state.doc;
    if (lifted.to > doc.content.size) return null;
    const node = doc.nodeAt(lifted.from);
    return node && lifted.from + node.nodeSize === lifted.to
      ? { from: lifted.from, to: lifted.to }
      : null;
  }
}

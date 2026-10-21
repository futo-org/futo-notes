import { IDLE_FALLBACK_DELAY_MS, IDLE_FALLBACK_SLICE_MS } from './blockDragCurtainConfig';
import { CurtainLayout } from './blockDragCurtainLayout';
import type { Reflow } from './blockDragCurtainTypes';

/** The curtain's parts: placing it, cloning a block into it, watching the
 * sizes of what it clones, and the idle timing its work runs on. */
export abstract class CurtainClones extends CurtainLayout {
  /** `requestIdleCallback`, or — in WebKit, which has none (WebKitGTK 2.4x,
   * and so desktop Linux and iOS) — a short timeout handing `run` a time slice
   * of the same shape. */
  protected whenIdle(
    run: (deadline: { timeRemaining(): number }) => void,
    timeout: number,
  ): number {
    const win = (this.doc.defaultView ?? window) as Window & {
      requestIdleCallback?: (
        cb: (deadline: { timeRemaining(): number }) => void,
        opts: { timeout: number },
      ) => number;
    };
    if (win.requestIdleCallback) return win.requestIdleCallback(run, { timeout });
    return win.setTimeout(() => {
      const end = performance.now() + IDLE_FALLBACK_SLICE_MS;
      run({ timeRemaining: () => Math.max(0, end - performance.now()) });
    }, IDLE_FALLBACK_DELAY_MS);
  }

  /** Sizes the clip and curtain to `reflow.box`. `mount` appends them (still
   * empty, transparent) in the lift's own write phase: appending them later,
   * inside the editor's container, made the frame that opened the curtain lay
   * the whole note out again (~36ms a time on a 3,000-block note on a budget
   * phone). (`contain: strict` on the clip, tried to keep later changes inside
   * it, made every drop 2-3x slower instead.) */
  protected placeCurtain(reflow: Reflow): void {
    const { clip, curtain, box } = reflow;
    clip.style.top = `${box.clip.top}px`;
    clip.style.left = `${box.clip.left}px`;
    clip.style.width = `${box.clip.width}px`;
    clip.style.height = `${box.clip.height}px`;
    curtain.style.left = `${box.left}px`;
    curtain.style.width = `${box.width}px`;
    curtain.style.height = `${box.height}px`;
  }

  protected addClone(reflow: Reflow, i: number): void {
    const live = this.view.dom.children[i];
    if (!(live instanceof HTMLElement)) return;
    const clone = live.cloneNode(true) as HTMLElement;
    clone.classList.remove('futo-mobile-dnd-source');
    for (const dimmed of Array.from(clone.querySelectorAll('.futo-mobile-dnd-source'))) {
      dimmed.classList.remove('futo-mobile-dnd-source');
    }
    if (i === reflow.sourceIndex) clone.classList.add('futo-mobile-dnd-reflow-source');
    const shift = this.reflowShift(i, reflow.applied);
    clone.style.top = `${this.slotTop(i) - reflow.insets[i]}px`;
    clone.style.left = `${reflow.lefts[i]}px`;
    clone.style.width = `${reflow.widths[i]}px`;
    clone.style.transform = `translateY(${shift}px)`;
    reflow.curtain.appendChild(clone);
    reflow.clones.set(i, { el: clone, shift });
    this.watch(reflow, live);
  }

  /** Watches `el`'s size (a cloned block, or the scroll box the clip covers).
   * Only the window's few dozen blocks: watching all 3,000 blocks of a long
   * note cost the budget phone ~8ms a frame for as long as the drag lasted
   * (2026-10-09), and a block outside the window only matters by moving it
   * (`followScroll`). */
  protected watch(reflow: Reflow, el: Element | undefined): void {
    if (!el || reflow.watched.has(el)) return;
    reflow.watched.add(el);
    reflow.unreported.add(el);
    reflow.sizes.observe(el);
  }

  protected unwatch(reflow: Reflow, el: Element | undefined): void {
    if (!el || !reflow.watched.delete(el)) return;
    reflow.unreported.delete(el);
    reflow.sizes.unobserve(el);
  }

  protected cancelIdleOpen(reflow: Reflow): void {
    this.cancelIdle(reflow.idleOpen);
    reflow.idleOpen = 0;
  }

  protected cancelIdle(id: number): void {
    if (!id) return;
    const win = (this.doc.defaultView ?? window) as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.cancelIdleCallback) win.cancelIdleCallback(id);
    else win.clearTimeout(id);
  }
}

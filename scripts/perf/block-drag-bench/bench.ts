/*
 * The block-drag benchmark itself, shared by the two pages that host it: the
 * desktop page (main.ts, the editor mounted bare in WebKitGTK) and the phone
 * page (phone.ts, riding inside the real editor.html bundle in Android Chrome).
 * It drives `BlockDragSession` directly — no handle hover, no long press, no
 * synthetic pointer events, no fixed sleeps — so each benchmark is just the
 * work being measured.
 *
 * Every benchmark but `scroll` forces style + layout after each step
 * (`settle`) and times that synchronously, so it needs no animation frames and
 * cannot stall on an unfocused window. `scroll` is the one frame-paced
 * benchmark: painting can only be observed through real frames.
 */
import { BlockDragSession } from '$features/editor/milkdown/blockDragSession';
import { undo } from '@milkdown/kit/prose/history';
import type { EditorView } from '@milkdown/kit/prose/view';
import { generateNote } from './note.mjs';
import { previewMode } from './preview-mode';

/** What a host page hands the benchmark: the live view, and a way to replace
 * the document. */
export interface BenchEditor {
  view(): EditorView | null;
  setContent(noteId: string, text: string): void;
}

export interface BenchPlan {
  repeat: number;
  sizes: number[];
  /** Show the grabbing-cursor layer the desktop handle gesture shows for the
   * length of a lift (handleBlockDrag.ts showCursorLayer). The long press has
   * none. */
  cursorLayer: boolean;
  reps: Record<string, { lift: number; gap: number; drop: number; frames: number }>;
}

const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** Lets the lift's own pop (120ms) and first slide (180ms) finish before a
 * frame-paced benchmark starts timing: no finger reaches a gap or the
 * auto-scroll edge that soon after a lift, so those frames are the lift's,
 * and `lift frame` times them. */
async function settleFrames(): Promise<void> {
  await raf();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await raf();
}

/** Forces the style + layout the step just dirtied, so the clock includes it. */
function settle(v: EditorView): void {
  void document.body.offsetHeight;
  v.dom.getBoundingClientRect();
}

function scroller(v: EditorView): HTMLElement {
  for (let el: HTMLElement | null = v.dom; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
      return el;
  }
  return document.scrollingElement as HTMLElement;
}

/** The first top-level block, lifted the way the gestures lift it. */
function liftFirst(v: EditorView) {
  const node = v.state.doc.child(0);
  const dom = v.nodeDOM(0) as HTMLElement;
  return { from: 0, to: node.nodeSize, dom, clone: dom.cloneNode(true) as HTMLElement };
}

/** Two pointer heights in different gaps, both on screen. */
function pointerPlan(v: EditorView) {
  const rect = v.dom.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  const first = (v.nodeDOM(0) as HTMLElement).getBoundingClientRect();
  return {
    x,
    liftY: first.top + Math.min(8, first.height / 2),
    yA: top + (bottom - top) * 0.45,
    yB: top + (bottom - top) * 0.85,
    yMid: top + (bottom - top) * 0.6,
  };
}

function firstIsHeading(v: EditorView): boolean {
  return v.state.doc.child(0).type.name === 'heading';
}

/** The session as the desktop handle drives it: the same calls, plus the
 * cursor layer it shows for the length of a lift (handleBlockDrag.ts). */
class HandleGesture {
  private layer: HTMLElement | null = null;
  constructor(
    private readonly session: BlockDragSession,
    private readonly cursorLayer: boolean,
  ) {}
  start(lift: ReturnType<typeof liftFirst>, x: number, y: number): void {
    if (this.cursorLayer) {
      this.layer = document.createElement('div');
      this.layer.className = 'futo-block-drag-cursor';
      document.body.appendChild(this.layer);
    }
    this.session.start(lift, x, y);
  }
  move(x: number, y: number): void {
    this.session.move(x, y);
  }
  finish(y: number, commit: boolean): boolean {
    this.layer?.remove();
    this.layer = null;
    return this.session.finish(y, commit);
  }
  cancel(): void {
    this.finish(0, false);
  }
}

/** Which preview the session is drawing: the drop line, or a reflow. */
function modeProbe(
  v: EditorView,
  session: HandleGesture,
  plan: ReturnType<typeof pointerPlan>,
): string {
  session.start(liftFirst(v), plan.x, plan.liftY);
  session.move(plan.x, plan.yB);
  settle(v);
  const mode = previewMode(v.dom);
  session.cancel();
  settle(v);
  return mode;
}

export type BenchResult = Record<string, { reps: number; totalMs: number; samplesMs?: number[] }>;

export function createBench(editor: BenchEditor) {
  function view(): EditorView {
    const v = editor.view();
    if (!v) throw new Error('bench: no ProseMirror view');
    return v;
  }

  async function load(blocks: number): Promise<void> {
    // Empty first: ProseMirror would otherwise reuse the previous run's equal
    // block views, and the timings would describe that history.
    editor.setContent(`bench-${blocks}`, '');
    await raf();
    editor.setContent(`bench-${blocks}`, generateNote(blocks));
    const deadline = performance.now() + 60_000;
    while (view().state.doc.childCount !== blocks && performance.now() < deadline) await raf();
    const v = view();
    if (v.state.doc.childCount !== blocks) {
      throw new Error(`bench: expected ${blocks} blocks, editor has ${v.state.doc.childCount}`);
    }
    scroller(v).scrollTop = 0;
    settle(v);
    // Let the first paint and any content-visibility activation finish.
    for (let frame = 0, last = Infinity; frame < 30 && (frame < 2 || last > 40); frame += 1) {
      const t = performance.now();
      await raf();
      last = performance.now() - t;
    }
  }

  async function run(blocks: number, reps: BenchPlan['reps'][string], cursorLayer: boolean) {
    await load(blocks);
    const v = view();
    const engine = new BlockDragSession(v);
    const session = new HandleGesture(engine, cursorLayer);
    const plan = pointerPlan(v);
    const mode = modeProbe(v, session, plan);
    const result: BenchResult = {};

    // Lift + cancel: the dim decoration transaction, the ghost, the reflow
    // setup and its teardown.
    let t = performance.now();
    for (let i = 0; i < reps.lift; i += 1) {
      session.start(liftFirst(v), plan.x, plan.liftY);
      settle(v);
      session.cancel();
      settle(v);
    }
    result['lift+cancel'] = { reps: reps.lift, totalMs: performance.now() - t };

    // Lift to first frame: the lift as the user sees it — its JS plus the
    // style, layout, paint and raster of the frame that first shows it.
    let liftFrameMs = 0;
    const liftFrames: number[] = [];
    for (let i = 0; i < reps.lift; i += 1) {
      await settleFrames();
      t = performance.now();
      session.start(liftFirst(v), plan.x, plan.liftY);
      await raf();
      await raf();
      const ms = performance.now() - t;
      liftFrameMs += ms;
      liftFrames.push(ms);
      session.cancel();
      settle(v);
    }
    result['lift frame'] = { reps: reps.lift, totalMs: liftFrameMs, samplesMs: liftFrames };

    // First move: the finger heads for a far gap one frame after the lift —
    // the worst case for any preview work deferred past the lift's frame.
    let firstMoveMs = 0;
    const firstMoves: number[] = [];
    for (let i = 0; i < reps.lift; i += 1) {
      await settleFrames();
      session.start(liftFirst(v), plan.x, plan.liftY);
      await raf();
      t = performance.now();
      session.move(plan.x, plan.yB);
      await raf();
      const ms = performance.now() - t;
      firstMoveMs += ms;
      firstMoves.push(ms);
      session.cancel();
      settle(v);
    }
    result['first move'] = { reps: reps.lift, totalMs: firstMoveMs, samplesMs: firstMoves };

    // Gap change: the pointer alternates between two gaps, so every step moves
    // the preview.
    session.start(liftFirst(v), plan.x, plan.liftY);
    settle(v);
    t = performance.now();
    for (let i = 0; i < reps.gap; i += 1) {
      session.move(plan.x, i % 2 ? plan.yA : plan.yB);
      settle(v);
    }
    result['gap change'] = { reps: reps.gap, totalMs: performance.now() - t };
    session.cancel();
    settle(v);

    // Gap change, frame-paced: the same alternation, one step per frame, so the
    // paint of each new preview (and its 180ms transition) is on the clock.
    session.start(liftFirst(v), plan.x, plan.liftY);
    await settleFrames();
    let samples: number[] = [];
    t = performance.now();
    for (let i = 0; i < reps.frames; i += 1) {
      const f = performance.now();
      session.move(plan.x, i % 2 ? plan.yA : plan.yB);
      await raf();
      samples.push(performance.now() - f);
    }
    result['gap frame'] = { reps: reps.frames, totalMs: performance.now() - t, samplesMs: samples };
    session.cancel();
    settle(v);

    // Drop: only the commit is timed; the undo that puts the note back is not.
    let dropMs = 0;
    for (let i = 0; i < reps.drop; i += 1) {
      session.start(liftFirst(v), plan.x, plan.liftY);
      session.move(plan.x, plan.yB);
      settle(v);
      t = performance.now();
      const moved = session.finish(plan.yB, true);
      settle(v);
      dropMs += performance.now() - t;
      if (!moved) throw new Error('bench: the drop did not move the block');
      undo(v.state, v.dispatch);
      settle(v);
      if (!firstIsHeading(v)) throw new Error('bench: undo did not restore the first block');
    }
    result['drop'] = { reps: reps.drop, totalMs: dropMs };

    // Scroll while dragging: frame-paced, the benchmark that sees painting.
    const sc = scroller(v);
    session.start(liftFirst(v), plan.x, plan.liftY);
    session.move(plan.x, plan.yMid);
    await settleFrames();
    samples = [];
    t = performance.now();
    for (let i = 0; i < reps.frames; i += 1) {
      const f = performance.now();
      sc.scrollTop += 23;
      session.move(plan.x, plan.yMid);
      await raf();
      samples.push(performance.now() - f);
    }
    result['scroll frame'] = {
      reps: reps.frames,
      totalMs: performance.now() - t,
      samplesMs: samples,
    };
    session.cancel();
    sc.scrollTop = 0;
    engine.destroy();

    // Anything the preview drew must be gone: a transform on a real block, or
    // the curtain (blockDragSession.ts) still on the page.
    const leftover =
      Array.from(v.dom.children).filter(
        (el) => (el as HTMLElement).style.transform || getComputedStyle(el).transform !== 'none',
      ).length + document.querySelectorAll('.futo-mobile-dnd-reflow-clip').length;
    return { blocks, mode, leftover, scroller: sc === v.dom ? 'editor' : sc.className, result };
  }

  /** The idle frame interval: what one vsync is on this screen. */
  async function idleFrameMs(): Promise<number> {
    await raf();
    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t = performance.now();
      await raf();
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  async function runPlan(plan: BenchPlan) {
    // The editor mounts asynchronously; wait for its view.
    for (let i = 0; i < 600 && !editor.view(); i += 1) await raf();
    const vsyncMs = await idleFrameMs();
    const runs = [];
    for (let r = 0; r < plan.repeat; r += 1) {
      for (const size of plan.sizes) runs.push(await run(size, plan.reps[size], plan.cursorLayer));
    }
    return {
      runs,
      screen: { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, vsyncMs },
    };
  }

  return { runPlan, load, view };
}

/*
 * `block-drag-bench.mjs --target app`: the scroll-drag benchmark inside the
 * WHOLE app shell (the plain-web build of App.svelte), not the bare editor
 * page. Injected into the app's index.html by the runner.
 *
 * It exists because the bare page measured 17–22ms scroll-drag frames for a
 * reflow drag that ran at 29–38fps in the desktop app, with the same engine,
 * layout and pixel ratio: something in the shell costs frames, and this is
 * where it can be bisected quickly.
 *
 * The drag goes through the real ⠿ handle with pointer events (the editor's
 * view is not reachable from the shell), so it pays the handle's hover wait —
 * once per drag, outside the timed frames.
 */
import { previewMode } from './preview-mode';

type AppPlan = {
  sizes: number[];
  repeat: number;
  frames: number;
  hide?: string;
  snapshot?: string;
};

/** Asks the host for a PNG of the window (webkitgtk-host.c) and waits for it. */
function snapshot(path: string): Promise<void> {
  return new Promise((resolve) => {
    (window as unknown as { __benchSnapshotDone: () => void }).__benchSnapshotDone = () =>
      resolve();
    const handler = (
      window as unknown as {
        webkit?: { messageHandlers?: { bench?: { postMessage(text: string): void } } };
      }
    ).webkit?.messageHandlers?.bench;
    if (handler) handler.postMessage(`snapshot:${path}`);
    else resolve();
  });
}

const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function post(message: unknown): void {
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { bench?: { postMessage(text: string): void } } };
    }
  ).webkit?.messageHandlers?.bench;
  const text = JSON.stringify(message);
  if (handler) handler.postMessage(text);
  else console.log(text);
}

/** Same generator as main.ts — kept in step by hand; both are bench-only. */
function generateNote(blocks: number): string {
  const lorem =
    'The quick brown fox jumps over the lazy dog while the editor keeps every keystroke instant and every block in place. ';
  const out: string[] = [];
  for (let i = 0; i < blocks; i += 1) {
    switch (i % 8) {
      case 0:
        out.push(`## Section ${i}`);
        break;
      case 1:
        out.push(
          `${lorem.repeat(1 + (i % 5))}**bold ${i}** and _italic_ and \`code\` and [link](https://example.com/${i}).`,
        );
        break;
      case 2:
        out.push(`- item ${i} a\n- item ${i} b\n  - nested ${i}\n- item ${i} c`);
        break;
      case 3:
        out.push(
          '```js\n' +
            Array.from({ length: 6 }, (_, k) => `const v${k} = ${i} * ${k}; // line ${k}`).join(
              '\n',
            ) +
            '\n```',
        );
        break;
      case 4:
        out.push(`> Quote ${i}: ${lorem.repeat(2)}`);
        break;
      case 5:
        out.push(`| a | b | c |\n| --- | --- | --- |\n| ${i} | x | y |\n| z | ${i} | w |`);
        break;
      case 6:
        out.push(`- [ ] task ${i}\n- [x] done ${i}`);
        break;
      default:
        out.push(`Short line ${i} #tag${i % 20}`);
    }
  }
  return out.join('\n\n') + '\n';
}

async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false,
  ms = 30000,
): Promise<T> {
  const until = performance.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() > until) throw new Error(`bench: timed out waiting for ${what}`);
    await sleep(50);
  }
}

type ShellHook = { replaceEditorContent(content: string): string };

async function load(blocks: number): Promise<{ pm: HTMLElement; scroller: HTMLElement }> {
  const hook = await waitFor(
    '__notesShellTest',
    () => (window as unknown as { __notesShellTest?: ShellHook }).__notesShellTest,
  );
  hook.replaceEditorContent(generateNote(blocks));
  const pm = await waitFor('the editor', () => {
    const el = document.querySelector<HTMLElement>('.ProseMirror');
    return el && el.children.length === blocks ? el : null;
  });
  const scroller = await waitFor('.note-body', () =>
    document.querySelector<HTMLElement>('.note-body'),
  );
  scroller.scrollTop = 0;
  await raf();
  await raf();
  return { pm, scroller };
}

async function scrollDrag(
  pm: HTMLElement,
  scroller: HTMLElement,
  frames: number,
  snapshotPath?: string,
) {
  scroller.scrollTop = 0;
  await raf();
  const first = pm.children[0].getBoundingClientRect();
  pm.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: first.left + 40,
      clientY: first.top + 8,
      pointerType: 'mouse',
    }),
  );
  const handle = await waitFor(
    'the ⠿ handle',
    () => document.querySelector<HTMLElement>('.milkdown-block-handle[data-show="true"]'),
    5000,
  );
  const box = handle.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y0 = box.top + box.height / 2;
  const pointer = (type: string, target: EventTarget, y: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      }),
    );
  pointer('pointerdown', handle, y0);
  pointer('pointermove', document, y0 + 6);
  await raf();
  const y = Math.min(400, innerHeight * 0.6);
  pointer('pointermove', document, y);
  await raf();
  await raf();
  const lifted = document.querySelector('.futo-mobile-dnd-ghost') !== null;
  if (snapshotPath) {
    await sleep(300); // past the 180ms slide and the card's 120ms pop
    await snapshot(snapshotPath);
  }
  const mode = previewMode(pm);
  // Per frame: the pointer's JS, then a forced style + layout, then whatever
  // the frame still costs (paint and compositing).
  let jsMs = 0;
  let layoutMs = 0;
  const start = performance.now();
  for (let i = 0; i < frames; i += 1) {
    scroller.scrollTop += 23;
    let t = performance.now();
    pointer('pointermove', document, y);
    jsMs += performance.now() - t;
    t = performance.now();
    void document.body.offsetHeight;
    layoutMs += performance.now() - t;
    await raf();
  }
  const totalMs = performance.now() - start;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pointer('pointerup', document, y);
  scroller.scrollTop = 0;
  await raf();
  if (!lifted) throw new Error('bench: the ⠿ press never lifted a block');
  return { mode, totalMs, jsMs, layoutMs };
}

async function runPlan(plan: AppPlan): Promise<void> {
  try {
    if (plan.hide) {
      const style = document.createElement('style');
      // A bare selector is hidden; anything with a `{` is used as CSS as is.
      style.textContent = plan.hide.includes('{')
        ? plan.hide
        : `${plan.hide} { display: none !important; }`;
      document.head.appendChild(style);
    }
    const runs = [];
    for (let r = 0; r < plan.repeat; r += 1) {
      for (const blocks of plan.sizes) {
        const { pm, scroller } = await load(blocks);
        const shot =
          plan.snapshot && r === 0 ? plan.snapshot.replace('.png', `-${blocks}.png`) : undefined;
        const { mode, totalMs, jsMs, layoutMs } = await scrollDrag(pm, scroller, plan.frames, shot);
        runs.push({
          blocks,
          mode,
          leftover: 0,
          scroller: 'note-body',
          result: {
            'scroll frame': { reps: plan.frames, totalMs },
            '  of which JS': { reps: plan.frames, totalMs: jsMs },
            '  of which style+layout': { reps: plan.frames, totalMs: layoutMs },
          },
        });
      }
    }
    post({ runs, screen: { dpr: devicePixelRatio, width: innerWidth, height: innerHeight } });
  } catch (error) {
    post({ error: String((error as Error)?.stack ?? error) });
  }
}

const planParam = new URLSearchParams(location.search).get('plan');
if (planParam) void runPlan(JSON.parse(planParam) as AppPlan);

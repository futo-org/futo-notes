// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Listener = (ev: Event) => void;

function installVisualViewport(initial: { height: number; offsetTop: number } = { height: 800, offsetTop: 0 }) {
  const listeners: Record<string, Set<Listener>> = {};
  const vv = {
    height: initial.height,
    offsetTop: initial.offsetTop,
    addEventListener(type: string, cb: Listener) {
      (listeners[type] ??= new Set()).add(cb);
    },
    removeEventListener(type: string, cb: Listener) {
      listeners[type]?.delete(cb);
    },
    __fire(type: string) {
      listeners[type]?.forEach((cb) => cb(new Event(type)));
    },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
  return vv;
}

async function freshKeyboard() {
  vi.resetModules();
  const mod = await import('./keyboard.svelte');
  return mod.keyboard;
}

describe('keyboard.offsetTop', () => {
  let vv: ReturnType<typeof installVisualViewport>;

  beforeEach(() => {
    vv = installVisualViewport();
  });

  afterEach(() => {
    // @ts-expect-error cleanup
    delete window.visualViewport;
    vi.restoreAllMocks();
  });

  it('starts at 0 before init', async () => {
    const kb = await freshKeyboard();
    expect(kb.offsetTop).toBe(0);
  });

  // After the state_unsafe_mutation fix (see keyboard.svelte.ts), all
  // viewport/scroll/focus listeners defer their $state writes via
  // queueMicrotask. Tests must flush microtasks before asserting.
  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it('reflects visualViewport.offsetTop after init and scroll', async () => {
    const kb = await freshKeyboard();
    kb.init();
    await flush();
    expect(kb.offsetTop).toBe(0);

    vv.offsetTop = 120;
    vv.__fire('scroll');
    await flush();
    expect(kb.offsetTop).toBe(120);

    vv.offsetTop = 0;
    vv.__fire('scroll');
    await flush();
    expect(kb.offsetTop).toBe(0);
  });

  it('also tracks offsetTop changes that arrive via resize (iOS keyboard)', async () => {
    const kb = await freshKeyboard();
    kb.init();
    await flush();

    // On iOS, focusing an input can shift the visual viewport via a resize
    // event without a separate scroll event firing.
    vv.height = 500;
    vv.offsetTop = 80;
    vv.__fire('resize');
    await flush();
    expect(kb.offsetTop).toBe(80);
  });

  it('clamps iOS layout viewport panning while the keyboard is visible', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Object.defineProperty(window, 'innerHeight', { value: 565, configurable: true, writable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true });
    document.documentElement.scrollTop = 120;
    document.body.scrollTop = 120;

    const kb = await freshKeyboard();
    kb.init();
    await flush();

    vv.height = 500;
    vv.offsetTop = 120;
    vv.__fire('resize');
    await flush();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(kb.height).toBe(300);
    expect(kb.offsetTop).toBe(0);
  });
});

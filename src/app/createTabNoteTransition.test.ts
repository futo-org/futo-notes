import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tabs = vi.hoisted(() => ({
  activeTabId: 'first',
  setTabState: vi.fn(),
  restoreAfterFailedNavigation: vi.fn(),
}));

vi.mock('$features/tabs/tabsStore.svelte', () => ({
  tabsStore: {
    get activeTabId() {
      return tabs.activeTabId;
    },
    setTabState: tabs.setTabState,
    restoreAfterFailedNavigation: tabs.restoreAfterFailedNavigation,
  },
}));

import { createTabNoteTransition } from './createTabNoteTransition';

describe('createTabNoteTransition', () => {
  let animationFrames: FrameRequestCallback[];

  beforeEach(() => {
    tabs.activeTabId = 'first';
    tabs.setTabState.mockReset();
    animationFrames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores the outgoing tab when its draft cannot be saved', async () => {
    const loadNote = vi.fn(async () => undefined);
    const transition = createTabNoteTransition({
      loadNote,
      getNoteBody: () => undefined,
      isNoteStreaming: () => false,
    });
    await transition.transition('first', 'One', 0);
    tabs.activeTabId = 'second';
    loadNote.mockRejectedValueOnce(new Error('disk full'));
    await transition.transition('second', 'Two', 0);
    expect(tabs.restoreAfterFailedNavigation).toHaveBeenCalledWith('first', 'One');
  });

  it('saves outgoing scroll and restores incoming scroll after two layout frames', async () => {
    const body = { scrollTop: 25 } as HTMLElement;
    const transition = createTabNoteTransition({
      loadNote: vi.fn(async () => undefined),
      getNoteBody: () => body,
      isNoteStreaming: () => false,
    });

    await transition.transition('first', 'One', 0);
    tabs.activeTabId = 'second';
    await transition.transition('second', 'Two', 120);

    expect(tabs.setTabState).toHaveBeenCalledWith('first', { scroll: 25 });
    expect(body.scrollTop).toBe(25);
    animationFrames.shift()?.(0);
    expect(body.scrollTop).toBe(25);
    animationFrames.shift()?.(0);
    expect(body.scrollTop).toBe(120);
  });

  it('does not apply a stale restore after another tab becomes active', async () => {
    const body = { scrollTop: 0 } as HTMLElement;
    const transition = createTabNoteTransition({
      loadNote: vi.fn(async () => undefined),
      getNoteBody: () => body,
      isNoteStreaming: () => false,
    });

    await transition.transition('first', 'One', 80);
    tabs.activeTabId = 'second';
    animationFrames.shift()?.(0);
    animationFrames.shift()?.(0);

    expect(body.scrollTop).toBe(0);
  });

  it('waits for a streaming note to reach the saved offset, unless the reader scrolls first', async () => {
    let streaming = true;
    const body = { scrollTop: 0, scrollHeight: 2_000, clientHeight: 500 } as HTMLElement;
    const transition = createTabNoteTransition({
      loadNote: vi.fn(async () => undefined),
      getNoteBody: () => body,
      isNoteStreaming: () => streaming,
    });
    const frames = (count: number) => {
      for (let i = 0; i < count; i += 1) animationFrames.shift()?.(0);
    };

    await transition.transition('first', 'Big', 5_000);
    frames(4);
    // Set now, the browser would clamp it to the 2 000px streamed so far.
    expect(body.scrollTop).toBe(0);
    (body as { scrollHeight: number }).scrollHeight = 6_000;
    frames(1);
    expect(body.scrollTop).toBe(5_000);

    tabs.activeTabId = 'second';
    await transition.transition('second', 'Other', 0);
    (body as { scrollHeight: number }).scrollHeight = 2_000;
    body.scrollTop = 0;
    tabs.activeTabId = 'first';
    await transition.transition('first', 'Big', 5_000);
    frames(3);
    body.scrollTop = 300; // the reader's own scroll, while the tail streams
    (body as { scrollHeight: number }).scrollHeight = 6_000;
    streaming = false;
    frames(4);
    expect(body.scrollTop).toBe(300);
  });
});

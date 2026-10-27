import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tabs = vi.hoisted(() => ({
  activeTabId: 'first',
  activeNoteId: null as string | null,
  setTabState: vi.fn(),
  restoreAfterFailedNavigation: vi.fn(),
}));

vi.mock('$features/tabs/tabsStore.svelte', () => ({
  tabsStore: {
    get activeTabId() {
      return tabs.activeTabId;
    },
    get activeNoteId() {
      return tabs.activeNoteId;
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
    tabs.activeNoteId = null;
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

  it('settles with the failure when the draft cannot be saved and the old tab comes back', async () => {
    const loadNote = vi.fn(async () => undefined);
    const transition = createTabNoteTransition({ loadNote, getNoteBody: () => undefined });
    tabs.activeNoteId = 'One';
    await transition.transition('first', 'One', 0);
    tabs.activeTabId = 'second';
    tabs.activeNoteId = 'Two';
    const settling = transition.settled();
    const failure = new Error('disk full');
    loadNote.mockRejectedValueOnce(failure);
    await transition.transition('second', 'Two', 0);
    await expect(settling).resolves.toBe(failure);
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

  it('settles only once the note the active tab asks for has loaded', async () => {
    // A dirty outgoing note is saved before the next one loads, so the load is slow.
    let finishLoad!: () => void;
    const loadNote = vi.fn(async (id: string | null) => {
      if (id === 'Two') await new Promise<void>((resolve) => (finishLoad = resolve));
    });
    const transition = createTabNoteTransition({ loadNote, getNoteBody: () => undefined });
    tabs.activeNoteId = 'One';
    await transition.transition('first', 'One', 0);
    expect(transition.settled()).toBeUndefined();

    // What an open does synchronously: the tab moves on, the effect has not run yet.
    tabs.activeNoteId = 'Two';
    const settling = transition.settled();
    expect(settling).toBeInstanceOf(Promise);
    let isSettled = false;
    void settling?.then(() => (isSettled = true));

    const switching = transition.transition('first', 'Two', 0);
    await Promise.resolve();
    expect(isSettled).toBe(false);
    finishLoad();
    await switching;
    await settling;
    expect(isSettled).toBe(true);
    expect(transition.settled()).toBeUndefined();
  });

  it("settles only once the incoming tab's saved scroll is restored", async () => {
    const body = { scrollTop: 0 } as HTMLElement;
    const transition = createTabNoteTransition({
      loadNote: vi.fn(async () => undefined),
      getNoteBody: () => body,
      isNoteStreaming: () => false,
    });
    tabs.activeNoteId = 'One';
    await transition.transition('first', 'One', 0);
    tabs.activeTabId = 'second';
    tabs.activeNoteId = 'Two';
    let scrollWhenSettled: number | null = null;
    const settling = transition.settled()?.then(() => (scrollWhenSettled = body.scrollTop));

    await transition.transition('second', 'Two', 120);
    expect(transition.settled()).toBeInstanceOf(Promise);
    animationFrames.shift()?.(0);
    animationFrames.shift()?.(0);
    await settling;
    expect(scrollWhenSettled).toBe(120);
    expect(transition.settled()).toBeUndefined();
  });
});

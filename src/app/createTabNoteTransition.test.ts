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
    });

    await transition.transition('first', 'One', 80);
    tabs.activeTabId = 'second';
    animationFrames.shift()?.(0);
    animationFrames.shift()?.(0);

    expect(body.scrollTop).toBe(0);
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

  it('loads the note a tab goes back to while the switch away from it still loads', async () => {
    // A large note takes a while to open; the tab goes back to the note it left meanwhile.
    let finishLoad!: () => void;
    const loadNote = vi.fn(async (id: string | null) => {
      if (id === 'Large') await new Promise<void>((resolve) => (finishLoad = resolve));
    });
    const transition = createTabNoteTransition({ loadNote, getNoteBody: () => undefined });
    tabs.activeNoteId = 'Small';
    await transition.transition('first', 'Small', 0);

    tabs.activeNoteId = 'Large';
    const toLarge = transition.transition('first', 'Large', 0);
    tabs.activeNoteId = 'Small';
    const back = transition.transition('first', 'Small', 0);
    finishLoad();
    await Promise.all([toLarge, back]);

    // The newest load is the note the tab shows (the session's loads supersede older ones).
    expect(loadNote.mock.calls.map(([id]) => id)).toEqual(['Small', 'Large', 'Small']);
    expect(transition.settled()).toBeUndefined();
  });

  it("settles only once the incoming tab's saved scroll is restored", async () => {
    const body = { scrollTop: 0 } as HTMLElement;
    const transition = createTabNoteTransition({
      loadNote: vi.fn(async () => undefined),
      getNoteBody: () => body,
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

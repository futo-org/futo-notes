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
    const transition = createTabNoteTransition({ loadNote, getNoteBody: () => undefined });
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
});

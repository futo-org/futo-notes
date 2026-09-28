// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NoteActionsMenu from './NoteActionsMenu.svelte';

describe('NoteActionsMenu', () => {
  let app: ReturnType<typeof mount> | null = null;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    document.body.innerHTML = '';
  });

  function menuItemsDisabled(locked: boolean): boolean[] {
    const noop = vi.fn();
    app = mount(NoteActionsMenu, {
      target: document.body,
      props: {
        open: true,
        ontoggle: noop,
        onclose: noop,
        oncopypath: noop,
        onmove: noop,
        ondelete: noop,
        locked,
      },
    });
    flushSync();
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
      (item) => item.disabled,
    );
  }

  // Copy path only reads; Move and Delete would write to a vault that refuses them.
  it('disables Move and Delete while locked, keeps Copy path', () => {
    expect(menuItemsDisabled(true)).toEqual([false, true, true]);
  });

  it('enables every item for a usable vault', () => {
    expect(menuItemsDisabled(false)).toEqual([false, false, false]);
  });
});

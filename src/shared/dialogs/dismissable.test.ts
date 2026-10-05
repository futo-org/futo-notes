// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';

import Modal from './Modal.svelte';

/**
 * The Escape contract every dialog inherits from `Modal` / `use:dismissable`.
 *
 * "Move to folder" shipped with no Escape at all because dismissal was each
 * dialog's own job. These assertions are what stop the next dialog from
 * repeating that: they exercise the composition, not one call site.
 */
describe('dialog dismissal contract', () => {
  let target: HTMLDivElement;
  const mounted: ReturnType<typeof mount>[] = [];

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    while (mounted.length) unmount(mounted.pop()!);
    target.remove();
  });

  const body = createRawSnippet(() => ({
    render: () => '<button>OK</button>',
  }));

  function mountModal(ondismiss: () => void, title = 'Test dialog'): void {
    mounted.push(mount(Modal, { target, props: { title, ondismiss, children: body } }));
    flushSync();
  }

  function pressEscape(): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();
  }

  it('closes only the top-most dialog, and keeps Escape away from whatever is behind', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      mountModal(outer, 'Outer');
      mountModal(inner, 'Inner');

      pressEscape();
      expect(inner).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('lets Escape through again once every dialog has unmounted', () => {
    const ondismiss = vi.fn();
    const behind = vi.fn();
    mountModal(ondismiss);

    unmount(mounted.pop()!);
    flushSync();

    document.addEventListener('keydown', behind);
    try {
      pressEscape();
      expect(ondismiss).not.toHaveBeenCalled();
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('dismisses on a backdrop click, and never on a click inside the card', () => {
    const ondismiss = vi.fn();
    mountModal(ondismiss);
    const card = document.querySelector('.modal-card') as HTMLElement;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(ondismiss).not.toHaveBeenCalled();

    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });

  it('returns focus to whatever was focused before it opened', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mountModal(vi.fn());
    expect(document.activeElement).not.toBe(opener);

    unmount(mounted.pop()!);
    flushSync();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

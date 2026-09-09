// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ContextMenu from './ContextMenu.svelte';

describe('ContextMenu dismissal', () => {
  let target: HTMLDivElement;
  let outside: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;
  const onclose = vi.fn();

  beforeEach(() => {
    target = document.createElement('div');
    outside = document.createElement('div');
    document.body.append(target, outside);
    app = mount(ContextMenu, {
      target,
      props: {
        x: 0,
        y: 0,
        items: [{ label: { path: 'sidebar.contextMenu.rename' }, onclick: vi.fn() }],
        onclose,
      },
    });
    flushSync();
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    outside.remove();
  });

  function press(element: Element): void {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    flushSync();
  }

  it('closes on a pointer press outside the menu', () => {
    press(outside);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a pointer press inside the menu', () => {
    press(document.querySelector('.context-menu .menu-item')!);
    expect(onclose).not.toHaveBeenCalled();
  });
});

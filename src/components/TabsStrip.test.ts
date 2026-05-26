// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TabsStrip from './TabsStrip.svelte';
import { tabsStore } from '$lib/tabsStore.svelte';
import { APP_CONTEXT_KEY, createAppContext } from '$lib/appContext.svelte';

describe('TabsStrip', () => {
  let target: HTMLDivElement;
  // svelte `mount` returns the component's exports; we don't need them
  // here — just keep a handle so afterEach can unmount.
  let app: ReturnType<typeof mount> | null = null;

  function mountStrip(): HTMLElement {
    app = mount(TabsStrip, {
      target,
      context: new Map([[APP_CONTEXT_KEY, createAppContext()]]),
    });
    return target.querySelector('.tabs-strip') as HTMLElement;
  }

  beforeEach(() => {
    tabsStore.__resetForTests();
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
    document.documentElement.style.removeProperty('--macos-titlebar-inset');
    document.documentElement.style.removeProperty('--macos-traffic-lights-width');
  });

  it('clicking the "+" button creates a new tab', () => {
    mountStrip();
    expect(tabsStore.tabs.length).toBe(1);

    const newBtn = target.querySelector('.tab-new-btn') as HTMLButtonElement;
    expect(newBtn).not.toBeNull();

    newBtn.click();
    expect(tabsStore.tabs.length).toBe(2);
  });

  it('strip is a Tauri drag region so the user can drag the window from its empty area', () => {
    // The strip lives at viewport y=0 on Mac (no more drag overlay
    // pushing tabs down). To keep window-drag possible, the strip
    // itself carries `data-tauri-drag-region`; per Tauri's docs the
    // attribute applies only to the element it's on, so child buttons
    // (tab pills, "+") still receive clicks normally. Removing this
    // would either kill window-drag from the tab band or, if a wrapper
    // overlay were re-introduced, re-break the click target.
    const strip = mountStrip();
    expect(strip).not.toBeNull();
    expect(strip.hasAttribute('data-tauri-drag-region')).toBe(true);
  });
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TabsStrip from './TabsStrip.svelte';
import { tabsStore } from '$lib/tabsStore.svelte';
import { APP_CONTEXT_KEY, createAppContext } from '$lib/appContext.svelte';

const HERE = dirname(fileURLToPath(import.meta.url));

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
  });

  it('clicking the "+" button creates a new tab', () => {
    mountStrip();
    expect(tabsStore.tabs.length).toBe(1);

    const newBtn = target.querySelector('.tab-new-btn') as HTMLButtonElement;
    expect(newBtn).not.toBeNull();

    newBtn.click();
    expect(tabsStore.tabs.length).toBe(2);
  });

  it('reserves room for the macOS titlebar drag region so the "+" button is clickable', () => {
    // App.svelte sets `--macos-titlebar-inset: 28px` on macOS desktop and
    // overlays a fixed `data-tauri-drag-region` div at top:0 / z-index:100
    // so the user can drag the window from the system-titlebar zone. The
    // tabs strip sits at the top of the notes shell — without accounting
    // for this inset, the drag region overlays the "+" button and Tauri
    // swallows the mousedown for window-drag, so the click never reaches
    // the button. Cmd+T still works because it bypasses the overlay.
    //
    // jsdom doesn't run vite-plugin-svelte's CSS injection so we read the
    // source <style> block directly and assert the strip declares a top
    // offset bound to the inset variable.
    const src = readFileSync(resolve(HERE, 'TabsStrip.svelte'), 'utf8');
    const styleBlock = src.match(/<style>([\s\S]+?)<\/style>/);
    expect(styleBlock, 'expected a <style> block in TabsStrip.svelte').not.toBeNull();

    const tabsStripRule = styleBlock![1].match(/\.tabs-strip\s*\{[\s\S]*?\}/);
    expect(tabsStripRule, 'expected a .tabs-strip rule').not.toBeNull();
    expect(tabsStripRule![0]).toMatch(/var\(--macos-titlebar-inset/);
  });
});

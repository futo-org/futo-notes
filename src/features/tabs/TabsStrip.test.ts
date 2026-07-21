// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TabsStrip from './TabsStrip.svelte';
import { tabsStore } from './tabsStore.svelte';
import type { NotePreview } from '$shared/types/note';

type TabsStripProps = {
  notes?: NotePreview[];
};

describe('TabsStrip', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  function mountStrip(props: TabsStripProps = {}): HTMLElement {
    app = mount(TabsStrip, {
      target,
      props,
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
    const strip = mountStrip();
    expect(strip).not.toBeNull();
    expect(strip.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('does not host a sidebar control — the top band owns it now', () => {
    mountStrip();
    expect(target.querySelector('.sidebar-expand-fallback-btn')).toBeNull();
    expect(target.querySelector('.sidebar-toggle-btn')).toBeNull();
  });

  it('clicking a tab pill activates it', () => {
    mountStrip();
    const first = tabsStore.tabs[0];
    tabsStore.newTab();
    expect(tabsStore.activeTabId).not.toBe(first.id);

    const firstPill = target.querySelector(`[data-tab-id="${first.id}"]`) as HTMLButtonElement;
    firstPill.click();
    expect(tabsStore.activeTabId).toBe(first.id);
  });

  it('tab pills are HTML5-draggable for reorder', () => {
    mountStrip();
    const pill = target.querySelector('.tab-pill') as HTMLButtonElement;
    expect(pill.getAttribute('draggable')).toBe('true');
  });
});

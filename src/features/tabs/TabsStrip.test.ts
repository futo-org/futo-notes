// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import TabsStrip from './TabsStrip.svelte';
import { tabsStore } from './tabsStore.svelte';
import type { NotePreview } from '$shared/types/note';

type TabsStripProps = {
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
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
    const strip = mountStrip();
    expect(strip).not.toBeNull();
    expect(strip.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('renders the collapsed-sidebar expand control before tab pills', () => {
    const onExpandSidebar = vi.fn();
    const strip = mountStrip({ sidebarCollapsed: true, onExpandSidebar });

    const expandBtn = target.querySelector('.sidebar-expand-btn') as HTMLButtonElement;
    const firstTab = target.querySelector('.tab-pill') as HTMLButtonElement;
    expect(expandBtn).not.toBeNull();
    expect(firstTab).not.toBeNull();
    expect(strip.firstElementChild).toBe(expandBtn);

    const children = Array.from(strip.children);
    expect(children.indexOf(expandBtn)).toBeLessThan(children.indexOf(firstTab));

    expandBtn.click();
    expect(onExpandSidebar).toHaveBeenCalledTimes(1);
  });
});

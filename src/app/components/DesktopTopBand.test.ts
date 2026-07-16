// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import DesktopTopBand from './DesktopTopBand.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

type TopBandProps = {
  sidebarCollapsed: boolean;
  ontoggle: () => void;
};

describe('DesktopTopBand', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  function mountBand(props: TopBandProps): void {
    app = mount(DesktopTopBand, { target, props });
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
  });

  it('is a Tauri drag region and embeds the tab strip', () => {
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });
    const band = target.querySelector('.desktop-topband') as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(target.querySelector('.tabs-strip')).not.toBeNull();
  });

  it('the sidebar toggle fires ontoggle', () => {
    const ontoggle = vi.fn();
    mountBand({ sidebarCollapsed: false, ontoggle });
    const btn = target.querySelector('.sidebar-toggle-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(ontoggle).toHaveBeenCalledTimes(1);
  });

  it('labels the toggle by sidebar state', () => {
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });
    let btn = target.querySelector('.sidebar-toggle-btn') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    unmount(app!);
    app = null;
    mountBand({ sidebarCollapsed: true, ontoggle: () => {} });
    btn = target.querySelector('.sidebar-toggle-btn') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

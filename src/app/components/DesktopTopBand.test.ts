// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import DesktopTopBand from './DesktopTopBand.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

const platform = vi.hoisted(() => ({
  layout: {
    left: [] as ('minimize' | 'maximize' | 'close')[],
    right: ['minimize', 'maximize', 'close'] as ('minimize' | 'maximize' | 'close')[],
  },
}));
vi.mock('$lib/platform', () => ({
  getWindowControlsLayout: vi.fn(() => Promise.resolve(platform.layout)),
  setAppWindowTitle: vi.fn(),
}));

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
    platform.layout = {
      left: [],
      right: ['minimize', 'maximize', 'close'],
    };
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

  it('makes the chrome column a drag region without hijacking the toggle', () => {
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });
    const chrome = target.querySelector('.topband-chrome') as HTMLElement;
    expect(chrome.hasAttribute('data-tauri-drag-region')).toBe(true);
    const btn = target.querySelector('.sidebar-toggle-btn') as HTMLButtonElement;
    expect(btn.hasAttribute('data-tauri-drag-region')).toBe(false);
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

  it('places trailing window controls after the tabs and outside drag regions', async () => {
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });

    await vi.waitFor(() => {
      expect(target.querySelectorAll('.window-control-btn')).toHaveLength(3);
    });
    const band = target.querySelector('.desktop-topband')!;
    const controls = target.querySelector('.window-controls-right')!;
    expect(controls.previousElementSibling).toBe(target.querySelector('.tabs-strip'));
    expect(band.contains(controls)).toBe(true);
    expect(controls.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(controls.querySelector('[data-tauri-drag-region]')).toBeNull();
  });

  it('places a leading desktop layout inside the chrome column in desktop order', async () => {
    platform.layout = {
      left: ['close', 'minimize', 'maximize'],
      right: [],
    };
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });

    await vi.waitFor(() => {
      expect(target.querySelector('.window-controls-left')).not.toBeNull();
    });
    const controls = target.querySelector('.window-controls-left')!;
    expect(controls.parentElement).toBe(target.querySelector('.topband-chrome'));
    expect(
      Array.from(controls.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Close', 'Minimize', 'Maximize']);
  });

  it('renders split desktop layouts on both sides of the tab strip', async () => {
    platform.layout = {
      left: ['close'],
      right: ['minimize', 'maximize'],
    };
    mountBand({ sidebarCollapsed: false, ontoggle: () => {} });

    await vi.waitFor(() => {
      expect(target.querySelectorAll('.window-control-btn')).toHaveLength(3);
    });
    expect(
      Array.from(target.querySelectorAll('.window-controls-left button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Close']);
    expect(
      Array.from(target.querySelectorAll('.window-controls-right button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Minimize', 'Maximize']);
  });
});

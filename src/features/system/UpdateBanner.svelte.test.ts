// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const upd = vi.hoisted(() => ({
  bannerVisible: false,
  phase: 'idle' as string,
  pending: null as { version: string; currentVersion: string } | null,
  percent: null as number | null,
  error: '',
  busy: false,
  install: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('./updateChecker.svelte', () => ({ updateChecker: upd }));

import UpdateBanner from './UpdateBanner.svelte';

describe('UpdateBanner', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  function render(): HTMLElement {
    app = mount(UpdateBanner, { target });
    return target;
  }

  beforeEach(() => {
    upd.bannerVisible = false;
    upd.phase = 'idle';
    upd.pending = null;
    upd.percent = null;
    upd.error = '';
    upd.busy = false;
    upd.install.mockReset();
    upd.restart.mockReset();
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

  it('renders nothing when the banner is not visible', () => {
    upd.bannerVisible = false;
    expect(render().querySelector('.update-banner')).toBeNull();
  });

  it('available: shows "Install v<version>" and clicking the pill installs', () => {
    upd.bannerVisible = true;
    upd.phase = 'available';
    upd.pending = { version: '1.6.0', currentVersion: '1.5.0' };
    const el = render();

    expect(el.querySelector('.update-pill-label')?.textContent).toContain('Install v1.6.0');
    expect(el.querySelector('.update-pill-icon')).not.toBeNull();

    (el.querySelector('.update-pill') as HTMLButtonElement).click();
    expect(upd.install).toHaveBeenCalledOnce();
  });

  it('has no dismiss control', () => {
    upd.bannerVisible = true;
    upd.phase = 'available';
    upd.pending = { version: '1.6.0', currentVersion: '1.5.0' };
    const el = render();

    expect(el.querySelector('.update-banner-close')).toBeNull();
    expect(el.querySelector('[aria-label*="Dismiss"]')).toBeNull();
  });

  it('downloading: shows percent, a determinate bar, disables the pill', () => {
    upd.bannerVisible = true;
    upd.phase = 'downloading';
    upd.percent = 42;
    upd.busy = true;
    const el = render();

    expect(el.querySelector('.update-pill-label')?.textContent).toContain('42%');
    expect(el.querySelector('.update-pill-icon')).toBeNull();
    const fill = el.querySelector('.update-pill-bar-fill') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe('42%');
    expect((el.querySelector('.update-pill') as HTMLButtonElement).disabled).toBe(true);
  });

  it('restart: shows "Restarting…" and is inert (auto-relaunch, no click needed)', () => {
    upd.bannerVisible = true;
    upd.phase = 'restart';
    const el = render();

    expect(el.querySelector('.update-pill-label')?.textContent).toContain('Restarting…');
    const pill = el.querySelector('.update-pill') as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    pill.click();
    expect(upd.restart).not.toHaveBeenCalled();
  });

  it('error: shows "Update failed", exposes the message as a title, retries on click', () => {
    upd.bannerVisible = true;
    upd.phase = 'error';
    upd.pending = { version: '1.6.0', currentVersion: '1.5.0' };
    upd.error = 'invalid encoding in minisign data';
    const el = render();

    expect(el.querySelector('.update-pill-label')?.textContent).toContain('Update failed');
    const pill = el.querySelector('.update-pill') as HTMLButtonElement;
    expect(pill.title).toContain('invalid encoding in minisign data');

    pill.click();
    expect(upd.install).toHaveBeenCalledOnce();
  });
});

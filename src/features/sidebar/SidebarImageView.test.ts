// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SidebarImageView from './SidebarImageView.svelte';
import { registeredVerbs } from '$app/puppet/puppetRegistry';

const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('$features/images/imageFiles', () => ({
  listImageFiles: async () => [
    { filename: 'photo.png', size: 2048, mtime: Date.now() - 3 * DAY_MS },
  ],
  deleteImage: async () => {},
  getImageWebPath: async () => 'blob:test-image',
}));

describe('SidebarImageView size + date metadata', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
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

  it('shows a compact size · date line on each grid row', async () => {
    app = mount(SidebarImageView, { target, props: {} });
    flushSync();

    await vi.waitFor(() => {
      expect(target.querySelector('.sidebar-image-thumb-meta')).toBeTruthy();
    });
    expect(target.querySelector('.sidebar-image-thumb-label')?.textContent).toBe('photo.png');
    expect(target.querySelector('.sidebar-image-thumb-meta')?.textContent).toBe(
      '2 KB · 3 days ago',
    );
  });

  it('shows name, size, and date in the detail view', async () => {
    app = mount(SidebarImageView, { target, props: {} });
    flushSync();

    await vi.waitFor(() => {
      expect(target.querySelector('.sidebar-image-thumb-btn')).toBeTruthy();
    });
    (target.querySelector('.sidebar-image-thumb-btn') as HTMLElement).click();
    flushSync();

    expect(target.querySelector('.sidebar-image-info-name')?.textContent).toBe('photo.png');
    expect(target.querySelector('.sidebar-image-info-size')?.textContent).toBe('2 KB · 3 days ago');
  });

  it('offers each verb only while its control is drawn', async () => {
    app = mount(SidebarImageView, { target, props: {} });
    const offered = (): string[] => (flushSync(), registeredVerbs().map((verb) => verb.name));
    const run = (name: string, args = {}) =>
      registeredVerbs()
        .find((verb) => verb.name === name)!
        .run(args);

    await vi.waitFor(() => expect(offered()).toEqual(['SelectImage']));
    await run('SelectImage', { filename: 'photo.png' });
    expect(offered()).toEqual(['DeselectImage', 'ToggleImageMenu']);
    await run('ToggleImageMenu');
    expect(offered()).toEqual(['DeselectImage', 'ToggleImageMenu', 'DeleteSelectedImage']);
  });
});

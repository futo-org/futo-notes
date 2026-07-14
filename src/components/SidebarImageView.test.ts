// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SidebarImageView from './SidebarImageView.svelte';

const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('$lib/images', () => ({
  listImageFiles: async () => [
    { filename: 'photo.png', size: 2048, mtime: Date.now() - 3 * DAY_MS },
  ],
  deleteImage: async () => {},
}));
vi.mock('$lib/localImages', () => ({
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

  // Regression (QA 2026-07-02): the images tab showed name only in the
  // grid and size only in the detail view. Spec list.md: the images tab
  // "lists the vault's images (name, size, date)".
  it('shows a compact size · date line on each grid row', async () => {
    app = mount(SidebarImageView, { target, props: {} });
    flushSync();

    await vi.waitFor(() => {
      expect(target.querySelector('.sidebar-image-thumb-meta')).toBeTruthy();
    });
    expect(target.querySelector('.sidebar-image-thumb-label')?.textContent).toBe('photo.png');
    expect(target.querySelector('.sidebar-image-thumb-meta')?.textContent).toBe('2.0 KB · 3d ago');
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
    expect(target.querySelector('.sidebar-image-info-size')?.textContent).toBe('2.0 KB · 3d ago');
  });
});

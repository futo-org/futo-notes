// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FolderPickerModal from './FolderPickerModal.svelte';
import { setFolderSnapshot } from './emptyFolders.svelte';

describe('FolderPickerModal', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(async () => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
    setFolderSnapshot([], []);
  });

  it('lists folders that contain no notes', async () => {
    setFolderSnapshot(['Empty', 'Empty/Nested'], []);

    app = mount(FolderPickerModal, {
      target,
      props: {
        notes: [],
        onpick: () => {},
        oncancel: () => {},
      },
    });
    flushSync();

    expect(document.querySelector('[data-folder-path="Empty"]')).toBeTruthy();
    expect(document.querySelector('[data-folder-path="Empty/Nested"]')).toBeTruthy();
  });
});

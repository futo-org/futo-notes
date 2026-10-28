// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FolderPickerModal from './FolderPickerModal.svelte';
import { runPuppetCommand } from '$app/puppet/puppetInspector';
import { clearPuppetVerbs } from '$app/puppet/puppetRegistry';

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
    clearPuppetVerbs();
  });

  it('PickFolder answers once the move it starts has landed', async () => {
    let land!: () => void;
    app = mount(FolderPickerModal, {
      target,
      props: {
        notes: [
          { id: 'work/standup', title: 'standup', preview: '', modificationTime: 0, tags: [] },
        ],
        onpick: () => new Promise<void>((resolve) => (land = resolve)),
        oncancel: () => {},
      },
    });
    flushSync();

    const receipt = runPuppetCommand('do', { verb: 'PickFolder', args: { path: 'work' } });
    expect(receipt.status).toBe(202);
    const { action } = receipt.body as { action: number };
    land();
    await vi.waitFor(() =>
      expect(runPuppetCommand('diff', { action }).body).toMatchObject({ status: 200 }),
    );
  });
});

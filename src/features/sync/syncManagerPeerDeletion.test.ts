// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptySummary,
  makeLiveNoteSession,
  makeManager,
  makeSession,
  openNoteMocks,
  resetSyncManagerHarness,
} from './__test__/syncManagerHarness';
import { noteExists } from '$features/notes/notes.svelte';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';
import { createSyncManager } from './syncManager.svelte';

beforeEach(resetSyncManagerHarness);

afterEach(() => {
  vi.useRealTimers();
});

describe('peer deletion safety', () => {
  it('keeps an unsaved draft and excludes it from tab pruning', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'base',
      reason: 'peerDeleted',
    });
    const bundle = makeManager(makeSession({ id: 'DirtyDoomed', content: 'LOCAL', dirty: true }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['DirtyDoomed', 'BackgroundGone'],
      peerDeletedIds: ['DirtyDoomed', 'BackgroundGone'],
    });
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['BackgroundGone']);
  });

  it('adopts a deleted-then-recreated note when it still exists on disk', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: '# recreated',
    });
    vi.mocked(noteExists).mockResolvedValue(true);
    const bundle = makeManager(makeSession({ id: 'Recreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Recreated'],
      deletedIds: ['Recreated'],
      peerUpdatedIds: ['Recreated'],
      peerDeletedIds: ['Recreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('# recreated');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('prunes only deleted background notes that are absent on disk', async () => {
    vi.mocked(noteExists).mockImplementation(async (id) => id === 'Recreated');
    const bundle = makeManager();
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['Gone', 'Recreated'],
      updatedIds: ['Recreated'],
      peerDeletedIds: ['Gone', 'Recreated'],
      peerUpdatedIds: ['Recreated'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Gone']);
  });

  it('keeps the open note and skips pruning when classification and probes reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openNoteMocks.classifyOpenNote.mockRejectedValueOnce(new Error('vault unavailable'));
    vi.mocked(noteExists).mockRejectedValue(new Error('vault unavailable'));
    const bundle = makeManager(makeSession({ id: 'ProbeError', content: 'OLD' }));
    await expect(
      bundle.manager.handleSyncComplete({
        ...emptySummary,
        deletedIds: ['ProbeError'],
        peerDeletedIds: ['ProbeError'],
      }),
    ).resolves.toBeUndefined();
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still adopts a legitimately empty recreated note', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: '' });
    vi.mocked(noteExists).mockResolvedValue(true);
    const bundle = makeManager(makeSession({ id: 'EmptyRecreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['EmptyRecreated'],
      deletedIds: ['EmptyRecreated'],
      peerDeletedIds: ['EmptyRecreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('still prunes other deleted tabs when the active note switches during a read', async () => {
    const bundle = makeManager(makeSession({ id: 'Active', content: 'OLD' }));
    vi.mocked(noteExists).mockImplementation(async (id) => id !== 'OtherGone');
    openNoteMocks.classifyOpenNote.mockImplementationOnce(async () => {
      bundle.state.id = 'Elsewhere';
      return { kind: 'adopt', content: '# fresh' };
    });
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Active'],
      deletedIds: ['Active', 'OtherGone'],
      peerUpdatedIds: ['Active'],
      peerDeletedIds: ['Active', 'OtherGone'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['OtherGone']);
  });
});

// The open note's fate belongs to the engine verdict alone: a projection that
// runs beside the executor (rename projection, deleted-tab pruning) must never
// move or close the session behind it.
describe('open-note fate stays with the engine verdict', () => {
  // The disp-05 interleaving, sequenced instead of raced: the body autosave
  // lands between a cycle's push and its pull, so the pull finds the local file
  // diverged from the deleted version and parks it into a conflict copy
  // (futo-notes-sync `tombstone_park_of_diverged_content_reports_rename_intent`),
  // moving the editor's attachment with it. Classified at the id it left, the
  // facts were the Close row — disk gone, draft equal to the just-saved base — so
  // the session follows the editor to the copy that holds the user's text first.
  it('follows a tombstone park onto the conflict copy holding the saved draft', async () => {
    const parkedId = 'Parked (conflict 019fdd01)';
    const live = makeLiveNoteSession('Parked', 'peer text');
    const onRename = vi.fn();
    const pruneTabsForDeletedIds = vi.fn();
    const toasts: ToastMessage[] = [];
    const manager = createSyncManager({
      session: live.session,
      showToast: (message) => toasts.push(message),
      onRename,
      pruneTabsForDeletedIds,
    });

    live.editContent('my draft');
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);

    live.relocate(parkedId);
    await manager.handleSyncComplete({
      ...emptySummary,
      conflicts: 1,
      deleted: 1,
      updatedIds: [parkedId],
      peerUpdatedIds: [parkedId],
      renamed: [{ fromId: 'Parked', toId: parkedId }],
    });

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: parkedId,
        base: 'my draft',
        draft: 'my draft',
        renamedTo: null,
      }),
    );
    expect(live.session.originalId).toBe(parkedId);
    expect(live.session.title).toBe(parkedId);
    expect(live.getEditorContent()).toBe('my draft');
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Parked', parkedId);
    expect(pruneTabsForDeletedIds).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  // Sibling of the reported-rename split: a background projection must never
  // decide the open note's fate. The engine said leave it open; if the file
  // disappears before the existence probe, pruning its tab would clear the
  // session and route home behind that verdict.
  it('never prunes the tab of a note the engine left open', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'leave' });
    vi.mocked(noteExists).mockResolvedValue(false);
    const bundle = makeManager(makeSession({ id: 'StillOpen', content: 'OLD' }));

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['StillOpen', 'BackgroundGone'],
      peerDeletedIds: ['StillOpen', 'BackgroundGone'],
    });

    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledExactlyOnceWith(['BackgroundGone']);
  });
});

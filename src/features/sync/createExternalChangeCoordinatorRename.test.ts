// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeCoordinator,
  makeSession,
  noteMocks,
  resetCoordinatorMocks,
  syncMocks,
} from './__test__/coordinatorHarness';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';

beforeEach(resetCoordinatorMocks);

describe('watcher rename semantics', () => {
  it('follows and auto-pushes a paired rename of the open note', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'renamed',
    });
    const bundle = makeCoordinator();

    await bundle.coordinator.handleFileChange({
      type: 'rename',
      filename: 'renamed.md',
      from: 'active.md',
    });

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'active', renamedTo: 'renamed' }),
    );
    expect(bundle.followRename).toHaveBeenCalledExactlyOnceWith('active', 'renamed');
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
  });

  it('treats a rename out of markdown as an unlink of the old note', async () => {
    const bundle = makeCoordinator();

    await bundle.coordinator.handleFileChange({
      type: 'rename',
      filename: 'active.txt',
      from: 'active.md',
    });

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'active', renamedTo: null }),
    );
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledExactlyOnceWith('active.md');
    expect(bundle.notifySaved).not.toHaveBeenCalled();
    bundle.coordinator.stop();
  });

  it('treats a rename into markdown as an added note', async () => {
    const bundle = makeCoordinator();

    await bundle.coordinator.handleFileChange({
      type: 'rename',
      filename: 'imported.md',
      from: 'imported.txt',
    });

    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledExactlyOnceWith('imported.md');
    expect(syncMocks.classifyOpenNote).not.toHaveBeenCalled();
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
  });

  // An atomic save through a temp file with a note's name (mkstemp with a
  // `.md` suffix, TextEdit's "(A Document Being Saved By …)" folder) is a
  // rename ONTO the open note: its bytes changed, so it is re-read like an
  // edit, pending save first. It must not be followed anywhere.
  it('re-reads the open note when a rename lands on it', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: 'saved elsewhere' });
    const bundle = makeCoordinator(makeSession({ savePending: true }));

    await bundle.coordinator.handleFileChange({
      type: 'rename',
      filename: 'active.md',
      from: 'tmpk3j2v9.md',
    });

    expect(bundle.session.flushSave).toHaveBeenCalled();
    expect(syncMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'active', renamedTo: null }),
    );
    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('saved elsewhere');
    expect(bundle.followRename).not.toHaveBeenCalled();
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledExactlyOnceWith('active.md');
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
  });

  // Linux inotify reports an atomic save through a hidden temp as an add of
  // the note it replaced.
  it('re-reads the open note when it is reported added', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: 'saved elsewhere' });
    const bundle = makeCoordinator();

    await bundle.coordinator.handleFileChange({ type: 'add', filename: 'active.md' });

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'active', renamedTo: null }),
    );
    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('saved elsewhere');
    bundle.coordinator.stop();
  });

  it('ignores a rename between non-markdown files', async () => {
    const bundle = makeCoordinator();

    await bundle.coordinator.handleFileChange({
      type: 'rename',
      filename: 'asset.json',
      from: 'asset.txt',
    });

    expect(noteMocks.handleExternalFileChange).not.toHaveBeenCalled();
    expect(syncMocks.classifyOpenNote).not.toHaveBeenCalled();
    expect(bundle.notifySaved).not.toHaveBeenCalled();
    bundle.coordinator.stop();
  });
});

describe('watcher rename batching', () => {
  it('keeps an open-note rename actionable inside a bulk watcher batch', async () => {
    vi.useFakeTimers();
    syncMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'renamed',
    });
    const bundle = makeCoordinator();

    bundle.coordinator.watcherBatch.enqueue({
      type: 'rename',
      filename: 'renamed.md',
      from: 'active.md',
    });
    for (let index = 0; index < 10; index += 1) {
      bundle.coordinator.watcherBatch.enqueue({
        type: 'change',
        filename: `background-${index}.md`,
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(bundle.followRename).toHaveBeenCalledExactlyOnceWith('active', 'renamed');
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
    vi.useRealTimers();
  });

  it('follows an open note through a bulk rename chain in event order', async () => {
    vi.useFakeTimers();
    syncMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'followRename', toId: 'middle' })
      .mockResolvedValueOnce({ kind: 'followRename', toId: 'final' });
    const bundle = makeCoordinator();

    bundle.coordinator.watcherBatch.enqueue({
      type: 'rename',
      filename: 'middle.md',
      from: 'active.md',
    });
    bundle.coordinator.watcherBatch.enqueue({
      type: 'rename',
      filename: 'final.md',
      from: 'middle.md',
    });
    for (let index = 0; index < 9; index += 1) {
      bundle.coordinator.watcherBatch.enqueue({
        type: 'unlink',
        filename: `removed-${index}.md`,
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(bundle.followRename.mock.calls).toEqual([
      ['active', 'middle'],
      ['middle', 'final'],
    ]);
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
    vi.useRealTimers();
  });

  it('preserves and auto-pushes an open-note rename drained after sync', async () => {
    vi.useFakeTimers();
    syncMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'renamed',
    });
    const bundle = makeCoordinator();

    bundle.coordinator.watcherBatch.setSyncActive(true);
    bundle.coordinator.watcherBatch.enqueue({
      type: 'rename',
      filename: 'renamed.md',
      from: 'active.md',
    });
    bundle.coordinator.watcherBatch.setSyncActive(false);
    bundle.coordinator.watcherBatch.drainPostSync();
    await vi.advanceTimersByTimeAsync(500);

    expect(bundle.followRename).toHaveBeenCalledExactlyOnceWith('active', 'renamed');
    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
    vi.useRealTimers();
  });

  it('auto-pushes a background rename inside a bulk watcher batch', async () => {
    vi.useFakeTimers();
    const bundle = makeCoordinator(makeSession({ originalId: null }));

    bundle.coordinator.watcherBatch.enqueue({
      type: 'rename',
      filename: 'renamed.md',
      from: 'old.md',
    });
    for (let index = 0; index < 10; index += 1) {
      bundle.coordinator.watcherBatch.enqueue({
        type: 'unlink',
        filename: `removed-${index}.md`,
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(bundle.notifySaved).toHaveBeenCalledOnce();
    bundle.coordinator.stop();
    vi.useRealTimers();
  });

  it('keeps suppressing non-active sync writes while active changes still classify', async () => {
    const suppressor = createWriteSuppressor();
    suppressor.recordSyncWrite('background.md');
    suppressor.recordSyncWrite('active.md');
    const bundle = makeCoordinator(makeSession(), suppressor);

    await bundle.coordinator.handleFileChange({ type: 'change', filename: 'background.md' });
    expect(noteMocks.handleExternalFileChange).not.toHaveBeenCalled();

    await bundle.coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    expect(syncMocks.classifyOpenNote).toHaveBeenCalledOnce();
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');
    bundle.coordinator.stop();
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';

const noteMocks = vi.hoisted(() => ({
  handleExternalFileChange: vi.fn(async () => {}),
  readNote: vi.fn(async () => ''),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

vi.mock('$features/notes/notes.svelte', () => noteMocks);
vi.mock('$lib/platform', () => ({ hasFileSystem: true }));

import { createExternalChangeCoordinator } from './createExternalChangeCoordinator';

describe('createExternalChangeCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles an active note after its direct read fails', async () => {
    noteMocks.readNote.mockRejectedValueOnce(new Error('transient read failure'));
    noteMocks.handleExternalFileChange.mockResolvedValueOnce(undefined);
    const notifySaved = vi.fn();
    const session = {
      title: 'active',
      content: 'local content',
      originalId: 'active',
      titleWarning: '',
      loading: false,
      editVersion: 0,
      lastEditTime: 0,
      savePending: false,
      dirty: false,
      editorContent: 'local content',
      editorFocused: false,
      composing: false,
      debouncedSave: vi.fn(),
      flushSave: vi.fn(async () => {}),
      loadNote: vi.fn(async () => {}),
      handleTitleInput: vi.fn(),
      handleTitleKeydown: vi.fn(),
      handleTitleFocus: vi.fn(),
      handleTitlePointerDown: vi.fn(),
      seedOpenNote: vi.fn(),
      cancelAndClear: vi.fn(),
      applyExternalContent: vi.fn(),
      applyRemoteRename: vi.fn(),
    } satisfies NoteSession;
    const coordinator = createExternalChangeCoordinator({
      session,
      notifySaved,
      showToast: vi.fn(),
      writeSuppressor: createWriteSuppressor(),
    });

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(noteMocks.readNote).toHaveBeenCalledWith('active');
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');
    expect(notifySaved).toHaveBeenCalledOnce();
    coordinator.stop();
  });
});

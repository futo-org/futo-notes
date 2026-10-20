// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoSyncCallbacks,
  controlledPromise,
  emptySummary,
  makeLiveNoteSession,
  makeManager,
  makeSession,
  managerFor,
  openNoteMocks,
  resetSyncManagerHarness,
  tauriEventMocks,
  yieldMicrotasks,
} from './__test__/syncManagerHarness';
import { updateNote } from '$features/notes/notes.svelte';

beforeEach(resetSyncManagerHarness);

afterEach(() => {
  vi.useRealTimers();
});

// eslint-disable-next-line max-lines-per-function -- One editor reconciliation matrix shares the manager/session harness.
describe('editor reconciliation', () => {
  it('adopts a live pull when no edits landed since the previous live completion', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: 'peer content',
    });
    const live = makeLiveNoteSession('Live pull', 'old content');
    live.editContent('already synced content');
    await live.session.flushSave();
    expect(live.session.editVersion).toBe(1);
    expect(live.session.dirty).toBe(false);

    const manager = managerFor(live.session);
    const cleanup = manager.start();
    const liveSynced = tauriEventMocks.listeners.get('sync:live-synced');
    expect(liveSynced).toBeDefined();

    // The previous live completion advances the epoch past the historical edit.
    liveSynced!({ payload: { ...emptySummary } });
    await yieldMicrotasks();

    liveSynced!({ payload: { ...emptySummary, updatedIds: ['Live pull'] } });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('peer content');
    expect(live.session.savedContent).toBe('peer content');
    expect(live.session.dirty).toBe(false);
    cleanup();
  });

  it('protects an edit that raced the live cycle start against the pulled content', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'draft in the race window',
      reason: 'diverged',
    });
    const live = makeLiveNoteSession('Race window', 'old content');
    const manager = managerFor(live.session);
    const cleanup = manager.start();

    // Edit + autosave land while a live cycle already runs in Rust; no
    // completion boundary has advanced the live epoch past them. A late
    // cycle-start capture must not reclassify the edit as pre-cycle.
    live.editContent('draft in the race window');
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);

    tauriEventMocks.listeners.get('sync:live-synced')!({
      payload: { ...emptySummary, updatedIds: ['Race window'] },
    });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('draft in the race window');
    // Protected means untouched on both counts: the pulled bytes reach neither
    // the buffer nor the baseline the next flush is conditioned on (#89).
    expect(live.session.savedContent).toBe('draft in the race window');
    cleanup();
  });

  it('advances the live epoch at completion arrival, not after its processing', async () => {
    const live = makeLiveNoteSession('Queued arrival', 'old content');
    const manager = managerFor(live.session);
    const cleanup = manager.start();
    const liveSynced = tauriEventMocks.listeners.get('sync:live-synced')!;

    // Completion 1 stalls on its disk read while the user edits and saves.
    const verdict = controlledPromise<{
      kind: 'keepDraft';
      base: string;
      reason: 'diverged';
    }>();
    openNoteMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    liveSynced({ payload: { ...emptySummary, updatedIds: ['Queued arrival'] } });
    live.editContent('draft during processing');
    await live.session.flushSave();
    verdict.resolve({ kind: 'keepDraft', base: 'draft during processing', reason: 'diverged' });
    await yieldMicrotasks();
    // The draft that landed mid-processing keeps its own baseline; completion
    // 1's pulled bytes never become the base a later flush would fast-forward
    // over (#89).
    expect(live.getEditorContent()).toBe('draft during processing');
    expect(live.session.savedContent).toBe('draft during processing');
    expect(live.session.dirty).toBe(false);

    // Completion 2's epoch was captured at completion 1's ARRIVAL — before the
    // edit — so the pulled content must be protected against, not adopted. An
    // epoch captured after completion 1's processing would misclassify the
    // edit as pre-cycle and adopt completion 2's pulled bytes over the draft.
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'draft during processing',
      reason: 'diverged',
    });
    liveSynced({ payload: { ...emptySummary, updatedIds: ['Queued arrival'] } });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('draft during processing');
    expect(live.session.savedContent).toBe('draft during processing');
    cleanup();
  });

  it('does not advance the live epoch on connect, protecting offline edits', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'edited while offline',
      reason: 'diverged',
    });
    const live = makeLiveNoteSession('Offline edit', 'old content');
    const manager = managerFor(live.session);
    const cleanup = manager.start();

    live.editContent('edited while offline');
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);

    // A connect capture would classify the offline edit as pre-cycle and let
    // the first pull adopt over it.
    manager.handleLiveState({ live: true, status: 'connected' });

    tauriEventMocks.listeners.get('sync:live-synced')!({
      payload: { ...emptySummary, updatedIds: ['Offline edit'] },
    });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('edited while offline');
    // The offline edit's own baseline survives the pull, so a later flush is a
    // three-way decision the engine can park rather than a fast-forward that
    // would overwrite what the first pull brought down (#89).
    expect(live.session.savedContent).toBe('edited while offline');
    cleanup();
  });

  it('keeps the live epoch independent of a JS cycle capture', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'old content',
      reason: 'diverged',
    });
    const bundle = makeManager(
      makeSession({ id: 'Epoch overlap', content: 'old content', editVersion: 1 }),
    );
    const cleanup = bundle.manager.start();

    // The JS cycle captures its own epoch at the current edit version; the
    // live epoch stays at its last completion boundary (0).
    autoSyncCallbacks!.onSyncStateChange(true);
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Epoch overlap'],
    });

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    // Not adopted, and the baseline the executor assigns is the one the session
    // already held: the pulled bytes are not this editor's to claim as its last
    // save (#89).
    expect(bundle.rebaseSavedContent).toHaveBeenCalledExactlyOnceWith('old content');
    expect(bundle.state.savedContent).toBe('old content');
    cleanup();
  });

  it('settles an in-flight parked save before deciding how to reconcile pulled content', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'adopt', content: 'peer content' })
      .mockResolvedValueOnce({ kind: 'leave' });
    const save = controlledPromise<void>();
    const bundle = makeManager(
      makeSession({
        id: 'Save race',
        content: 'local draft',
        savedContent: 'old base',
        dirty: true,
        savePending: true,
      }),
    );
    vi.mocked(bundle.session.flushSave).mockImplementationOnce(async () => {
      await save.promise;
      await bundle.manager.reconcileOpenNote('Save race', {
        content: 'local draft',
        title: 'Save race',
      });
      bundle.state.savePending = false;
      bundle.state.dirty = false;
    });

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Save race'],
    });
    await vi.waitFor(() => expect(bundle.session.flushSave).toHaveBeenCalledOnce());
    expect(openNoteMocks.classifyOpenNote).not.toHaveBeenCalled();
    expect(bundle.rebaseSavedContent).not.toHaveBeenCalled();

    save.resolve();
    await reconciliation;

    expect(bundle.applyExternalContent).toHaveBeenCalledWith('peer content');
    expect(bundle.state.content).toBe('peer content');
    expect(bundle.state.savedContent).toBe('peer content');
  });

  it('serializes overlapping completions so the later cycle content wins', async () => {
    const firstVerdict = controlledPromise<{ kind: 'adopt'; content: string }>();
    openNoteMocks.classifyOpenNote
      .mockReturnValueOnce(firstVerdict.promise)
      .mockResolvedValueOnce({ kind: 'adopt', content: 'later cycle content' });
    const bundle = makeManager(makeSession({ id: 'Overlap', content: 'base' }));

    const first = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Overlap'],
    });
    const second = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Overlap'],
    });
    await yieldMicrotasks();

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledTimes(1);
    firstVerdict.resolve({ kind: 'adopt', content: 'earlier cycle content' });
    await Promise.all([first, second]);

    expect(bundle.applyExternalContent.mock.calls).toEqual([
      ['earlier cycle content'],
      ['later cycle content'],
    ]);
    expect(bundle.state.content).toBe('later cycle content');
  });

  it('silently rebases when pulled content already matches the editor', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'converged content',
      reason: 'converged',
    });
    const live = makeLiveNoteSession('Converged', 'old base');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(updateNote).mockRejectedValueOnce(new Error('write failed'));
    live.editContent('converged content');
    await expect(live.session.flushSave()).rejects.toThrow('write failed');
    warn.mockRestore();
    expect(live.session.savedContent).toBe('old base');
    expect(live.session.dirty).toBe(true);

    const manager = managerFor(live.session);

    await manager.handleSyncComplete({ ...emptySummary, updatedIds: ['Converged'] });

    expect(live.getEditorContent()).toBe('converged content');
    expect(live.setEditorContent).not.toHaveBeenCalled();
    expect(live.session.savedContent).toBe('converged content');
    expect(live.session.dirty).toBe(false);
  });

  it('defers a watcher adopt during composition until the editor blurs', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: 'FRESH',
    });
    const bundle = makeManager(
      makeSession({ id: 'WatcherFocus', content: 'OLD', focused: true, composing: true }),
    );
    await bundle.manager.handleFileChange({ type: 'change', filename: 'WatcherFocus.md' });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    bundle.state.composing = false;
    bundle.state.focused = false;
    await bundle.manager.handleEditorFocusChange(false);
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('adopts watcher and sync content immediately when the editor is not focused', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const watcher = makeManager(makeSession({ id: 'WatcherBlur', content: 'OLD' }));
    await watcher.manager.handleFileChange({ type: 'change', filename: 'WatcherBlur.md' });
    expect(watcher.applyExternalContent).toHaveBeenCalledWith('FRESH');

    const synced = makeManager(makeSession({ id: 'SyncBlur', content: 'OLD' }));
    await synced.manager.handleSyncComplete({ ...emptySummary, updatedIds: ['SyncBlur'] });
    expect(synced.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('flushes a draft created while deferred before adopting sync content on blur', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'deferAdopt' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const bundle = makeManager(makeSession({ id: 'DirtyLater', content: 'OLD', focused: true }));
    await bundle.manager.handleSyncComplete({ ...emptySummary, updatedIds: ['DirtyLater'] });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    bundle.state.focused = false;
    bundle.state.dirty = true;
    bundle.state.content = 'LOCAL';
    vi.mocked(bundle.session.flushSave).mockImplementationOnce(async () => {
      bundle.state.dirty = false;
    });
    await bundle.manager.handleEditorFocusChange(false);

    expect(bundle.session.flushSave).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
    expect(bundle.toasts).toEqual([]);
  });
});

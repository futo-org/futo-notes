import { describe, expect, it } from 'vitest';

import { editorHasUnseenChanges, isEditorChangeEcho, shouldWriteNoteToDisk } from './noteSession.svelte.ts';

describe('shouldWriteNoteToDisk', () => {
  it('persists a new note when the title was changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled',
        newTitle: 'Title only',
        content: '',
        newContent: '',
      }),
    ).toBe(true);
  });

  it('skips writes for a brand-new note that was never touched', () => {
    // Regression: programmatic setEditorContent('') during loadNote('new')
    // used to fire a phantom debouncedSave, which wrote an empty note
    // to disk just because originalId was null.
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled (1)',
        newTitle: 'Untitled (1)',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });

  it('skips writes for existing notes when neither title nor content changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Existing',
        newTitle: 'Existing',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });
});

describe('editorHasUnseenChanges', () => {
  // Regression: the editor's onchange is rAF-coalesced, and rAF stalls while
  // the window is hidden/occluded (macOS WKWebView). Typed content then never
  // arms the save timer, so flushSave used to no-op and the keystrokes were
  // silently dropped on close/quit/note-switch (caught by the cross-platform
  // "tombstone does not block new note" scenario running with hidden windows).
  it('reports typed content the save pipeline never saw', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: '# Fresh note',
        savedContent: '',
        title: 'Untitled',
        savedTitle: 'Untitled',
      }),
    ).toBe(true);
  });

  it('reports an unsaved title-only change', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: 'body',
        savedContent: 'body',
        title: 'Renamed',
        savedTitle: 'Original',
      }),
    ).toBe(true);
  });

  it('is clean when editor and title match the last save', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: 'body',
        savedContent: 'body',
        title: 'Same',
        savedTitle: 'Same',
      }),
    ).toBe(false);
  });

  it('is clean when there is no editor (content undefined)', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: undefined,
        savedContent: 'anything',
        title: 'a',
        savedTitle: 'b',
      }),
    ).toBe(false);
  });
});

describe('isEditorChangeEcho', () => {
  // Regression: applyExternalContent raises suppressSaveOnChange around its
  // setEditorContent call, but the editor's onchange is rAF-coalesced — the
  // delivery lands one frame later, after the flag is already lowered. That
  // echo bumped editVersion, so handleSyncComplete's editedDuringSync gate
  // silently skipped every SUBSEQUENT remote adopt of the open note: the
  // first live-pulled edit appeared, the second never did until the note was
  // reopened (observed 2026-06-04, iPhone → mac "Yes." / "No." repro).
  it('treats the rAF-deferred delivery of adopted content as an echo', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote content',
        content: 'remote content',
        savedContent: 'remote content',
      }),
    ).toBe(true);
  });

  it('treats a real edit as an edit', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote content plus a keystroke',
        content: 'remote content',
        savedContent: 'remote content',
      }),
    ).toBe(false);
  });

  it('still counts a type-then-revert delivery so session content converges', () => {
    // Doc went old → old+x → old. The second delivery matches savedContent
    // but NOT the session's last-seen content, so it must flow through
    // (otherwise session.content would be left stale at old+x).
    expect(
      isEditorChangeEcho({
        nextContent: 'old',
        content: 'old+x',
        savedContent: 'old',
      }),
    ).toBe(false);
  });

  it('never classifies a title-only debounce (no content payload) as an echo', () => {
    expect(
      isEditorChangeEcho({
        nextContent: undefined,
        content: 'body',
        savedContent: 'body',
      }),
    ).toBe(false);
  });
});

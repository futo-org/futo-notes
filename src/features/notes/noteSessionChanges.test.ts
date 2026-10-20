// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  editorHasUnseenChanges,
  isEditorChangeEcho,
  shouldWriteNoteToDisk,
} from './noteSessionChanges';

describe('shouldWriteNoteToDisk', () => {
  it.each([
    ['persists a new note when the title was changed', 'Untitled', 'Title only', true],
    [
      'skips writes for a brand-new note that was never touched',
      'Untitled (1)',
      'Untitled (1)',
      false,
    ],
    [
      'skips writes for existing notes when neither title nor content changed',
      'Existing',
      'Existing',
      false,
    ],
  ])('%s', (_name, savedTitle, newTitle, expected) => {
    expect(shouldWriteNoteToDisk({ savedTitle, newTitle, content: '', newContent: '' })).toBe(
      expected,
    );
  });
});

describe('editorHasUnseenChanges', () => {
  it.each([
    [
      'reports typed content the save pipeline never saw',
      '# Fresh note',
      '',
      'Untitled',
      'Untitled',
      true,
    ],
    ['reports an unsaved title-only change', 'body', 'body', 'Renamed', 'Original', true],
    ['is clean when editor and title match the last save', 'body', 'body', 'Same', 'Same', false],
    [
      'is clean when there is no editor (content undefined)',
      undefined,
      'anything',
      'a',
      'b',
      false,
    ],
  ])('%s', (_name, editorContent, savedContent, title, savedTitle, expected) => {
    expect(editorHasUnseenChanges({ editorContent, savedContent, title, savedTitle })).toBe(
      expected,
    );
  });
});

describe('isEditorChangeEcho', () => {
  it.each([
    [
      'treats the rAF-deferred delivery of adopted content as an echo',
      'remote content',
      'remote content',
      'remote content',
      true,
    ],
    [
      'treats a real edit as an edit',
      'remote content plus a keystroke',
      'remote content',
      'remote content',
      false,
    ],
    [
      'still counts a type-then-revert delivery so session content converges',
      'old',
      'old+x',
      'old',
      false,
    ],
    [
      'never classifies a title-only debounce (no content payload) as an echo',
      undefined,
      'body',
      'body',
      false,
    ],
  ])('%s', (_name, nextContent, content, savedContent, expected) => {
    expect(isEditorChangeEcho({ nextContent, content, savedContent })).toBe(expected);
  });
});

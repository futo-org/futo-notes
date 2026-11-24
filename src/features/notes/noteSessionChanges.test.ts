// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editorHasUnseenChanges } from './noteSessionChanges';

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

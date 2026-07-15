import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureSafeNoteId, safeNotePath, safeAppdataPath, noteIdFromFilename } from './pathSafety';

interface PathSafetyFixture {
  cases: Array<{ id: string; valid: boolean }>;
}

const pathSafetyFixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../tests/conformance/path-safety.json'),
    'utf8',
  ),
) as PathSafetyFixture;

// ── ensureSafeNoteId ──────────────────────────────────────────────────
describe('ensureSafeNoteId', () => {
  it('matches the shared Rust/TypeScript boundary corpus', () => {
    for (const testCase of pathSafetyFixture.cases) {
      if (testCase.valid) {
        expect(() => ensureSafeNoteId(testCase.id)).not.toThrow();
      } else {
        expect(() => ensureSafeNoteId(testCase.id)).toThrow();
      }
    }
  });
  it('rejects empty string', () => {
    expect(() => ensureSafeNoteId('')).toThrow('note id cannot be empty');
  });

  it('rejects depth above MAX_FOLDER_DEPTH', () => {
    const tooDeep = Array.from({ length: 12 }, (_, i) => `f${i}`).join('/');
    expect(() => ensureSafeNoteId(tooDeep)).toThrow();
  });

  it('rejects forbidden characters', () => {
    expect(() => ensureSafeNoteId('<test>')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note:colon')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note"quote')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note|pipe')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note?question')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note*star')).toThrow('invalid note id');
  });

  it('rejects control characters', () => {
    expect(() => ensureSafeNoteId('note\x00null')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note\x1ftab')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('note\x7fdel')).toThrow('invalid note id');
  });

  it('rejects null bytes at various positions', () => {
    expect(() => ensureSafeNoteId('note\x00')).toThrow();
    expect(() => ensureSafeNoteId('\x00note')).toThrow();
    expect(() => ensureSafeNoteId('no\x00te')).toThrow();
  });

  it('accepts valid names', () => {
    expect(() => ensureSafeNoteId('hello world')).not.toThrow();
    expect(() => ensureSafeNoteId('my-note')).not.toThrow();
    expect(() => ensureSafeNoteId('cafe\u0301')).not.toThrow(); // café with combining accent
    expect(() => ensureSafeNoteId('.hidden')).not.toThrow();
  });

  it('accepts whitespace-only IDs (Rust behavior)', () => {
    expect(() => ensureSafeNoteId('   ')).not.toThrow();
    expect(() => ensureSafeNoteId(' ')).not.toThrow();
  });

  it('accepts unicode and emoji', () => {
    expect(() => ensureSafeNoteId('\u{1F4DD} notes')).not.toThrow(); // 📝
    expect(() => ensureSafeNoteId('cafe\u0301 \u2615')).not.toThrow(); // café ☕
    expect(() => ensureSafeNoteId('\u65E5\u672C\u8A9E\u30CE\u30FC\u30C8')).not.toThrow(); // 日本語ノート
  });

  it('allows leading/trailing dots (unlike title validation)', () => {
    expect(() => ensureSafeNoteId('trailing.')).not.toThrow();
    expect(() => ensureSafeNoteId('...dots')).not.toThrow();
  });

  it('rejects adversarial inputs', () => {
    expect(() => ensureSafeNoteId('../../../etc/passwd')).toThrow();
    expect(() => ensureSafeNoteId('..\\..\\windows\\system32')).toThrow();
    expect(() => ensureSafeNoteId('note<script>')).toThrow();
  });
  it('works correctly when called multiple times (no regex state leak)', () => {
    expect(() => ensureSafeNoteId('valid-note')).not.toThrow();
    expect(() => ensureSafeNoteId('also-valid')).not.toThrow();
    expect(() => ensureSafeNoteId('bad<note')).toThrow();
    expect(() => ensureSafeNoteId('still-valid')).not.toThrow();
  });
});

describe('safeNotePath', () => {
  it('returns base/id.md for valid ID', () => {
    expect(safeNotePath('/notes', 'hello world')).toBe('/notes/hello world.md');
  });

  it('throws on invalid ID', () => {
    expect(() => safeNotePath('/notes', '')).toThrow();
    expect(() => safeNotePath('/notes', '..')).toThrow();
    expect(() => safeNotePath('/notes', 'a/../b')).toThrow();
    expect(() => safeNotePath('/notes', 'bad<char')).toThrow();
  });

  it('builds nested path for path-as-ID', () => {
    expect(safeNotePath('/notes', 'Specs/folder-support')).toBe('/notes/Specs/folder-support.md');
    expect(safeNotePath('/notes', 'a/b/c')).toBe('/notes/a/b/c.md');
  });
});

describe('safeAppdataPath', () => {
  const base = '/tmp/test';

  it('rejects absolute paths', () => {
    expect(() => safeAppdataPath(base, '/etc/passwd')).toThrow('path traversal blocked');
  });

  it('rejects .. traversal', () => {
    expect(() => safeAppdataPath(base, '..')).toThrow('path traversal blocked');
    expect(() => safeAppdataPath(base, '../etc/passwd')).toThrow('path traversal blocked');
    expect(() => safeAppdataPath(base, 'subdir/../../etc')).toThrow('path traversal blocked');
  });

  it('rejects empty components (double slashes)', () => {
    expect(() => safeAppdataPath(base, 'sub//file')).toThrow('path traversal blocked');
  });

  it('accepts valid relative paths', () => {
    expect(safeAppdataPath(base, '.preferences.json')).toBe('/tmp/test/.preferences.json');
    expect(safeAppdataPath(base, 'subdir/file.json')).toBe('/tmp/test/subdir/file.json');
  });

  it('rejects . components (plugin-fs scope rejects them as forbidden)', () => {
    expect(() => safeAppdataPath(base, '.')).toThrow('path traversal blocked');
    expect(() => safeAppdataPath(base, './file.json')).toThrow('path traversal blocked');
    expect(() => safeAppdataPath(base, 'sub/./file.json')).toThrow('path traversal blocked');
  });
});

describe('noteIdFromFilename', () => {
  it('strips .md suffix', () => {
    expect(noteIdFromFilename('hello.md')).toBe('hello');
    expect(noteIdFromFilename('my note.md')).toBe('my note');
  });

  it('handles nested path filenames', () => {
    expect(noteIdFromFilename('Specs/folder.md')).toBe('Specs/folder');
    expect(noteIdFromFilename('a/b/c.md')).toBe('a/b/c');
    expect(noteIdFromFilename('Specs\\folder.md')).toBe('Specs/folder');
  });

  it('throws for non-.md files', () => {
    expect(() => noteIdFromFilename('hello.txt')).toThrow();
    expect(() => noteIdFromFilename('hello')).toThrow();
    expect(() => noteIdFromFilename('shopping')).toThrow();
  });

  it('throws for .md alone (empty ID)', () => {
    expect(() => noteIdFromFilename('.md')).toThrow('note id cannot be empty');
  });

  it('is case-sensitive (.MD does not match)', () => {
    expect(() => noteIdFromFilename('note.MD')).toThrow();
    expect(() => noteIdFromFilename('note.Md')).toThrow();
    expect(() => noteIdFromFilename('note.mD')).toThrow();
  });

  it('strips only one trailing .md', () => {
    expect(noteIdFromFilename('note.md.md')).toBe('note.md');
    expect(noteIdFromFilename('note.md.md.md')).toBe('note.md.md');
  });

  it('handles unicode and emoji filenames', () => {
    expect(noteIdFromFilename('cafe\u0301 \u2615.md')).toBe('cafe\u0301 \u2615');
    expect(noteIdFromFilename('\u{1F4DD} notes.md')).toBe('\u{1F4DD} notes');
  });

  it('handles dots in titles', () => {
    expect(noteIdFromFilename('v2.0 release.md')).toBe('v2.0 release');
    expect(noteIdFromFilename('Dr. Smith.md')).toBe('Dr. Smith');
  });

  it('handles .md embedded but not at suffix', () => {
    expect(() => noteIdFromFilename('file.md.txt')).toThrow();
  });
});

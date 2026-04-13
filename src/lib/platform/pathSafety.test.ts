import { describe, it, expect } from 'vitest';
import {
  ensureSafeNoteId,
  safeNotePath,
  safeAppdataPath,
  noteIdFromFilename,
} from './pathSafety';

// ── ensureSafeNoteId ──────────────────────────────────────────────────

describe('ensureSafeNoteId', () => {
  it('rejects empty string', () => {
    expect(() => ensureSafeNoteId('')).toThrow('note id cannot be empty');
  });

  it('rejects . and ..', () => {
    expect(() => ensureSafeNoteId('.')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('..')).toThrow('invalid note id');
  });

  it('rejects path separators', () => {
    expect(() => ensureSafeNoteId('foo/bar')).toThrow('invalid note id');
    expect(() => ensureSafeNoteId('foo\\bar')).toThrow('invalid note id');
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

  // Adversarial inputs matching Rust tests
  it('rejects adversarial inputs', () => {
    expect(() => ensureSafeNoteId('../../../etc/passwd')).toThrow();
    expect(() => ensureSafeNoteId('..\\..\\windows\\system32')).toThrow();
    expect(() => ensureSafeNoteId('note<script>')).toThrow();
  });

  it('works correctly when called multiple times (no regex state leak)', () => {
    // The global regex bug: if lastIndex isn't reset, alternating calls can fail
    expect(() => ensureSafeNoteId('valid-note')).not.toThrow();
    expect(() => ensureSafeNoteId('also-valid')).not.toThrow();
    expect(() => ensureSafeNoteId('bad<note')).toThrow();
    expect(() => ensureSafeNoteId('still-valid')).not.toThrow();
  });
});

// ── safeNotePath ──────────────────────────────────────────────────────

describe('safeNotePath', () => {
  it('returns base/id.md for valid ID', () => {
    expect(safeNotePath('/notes', 'hello world')).toBe('/notes/hello world.md');
  });

  it('throws on invalid ID', () => {
    expect(() => safeNotePath('/notes', '')).toThrow();
    expect(() => safeNotePath('/notes', '..')).toThrow();
    expect(() => safeNotePath('/notes', 'bad/path')).toThrow();
    expect(() => safeNotePath('/notes', 'bad<char')).toThrow();
  });
});

// ── safeAppdataPath ───────────────────────────────────────────────────

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

// ── noteIdFromFilename ────────────────────────────────────────────────

describe('noteIdFromFilename', () => {
  it('strips .md suffix', () => {
    expect(noteIdFromFilename('hello.md')).toBe('hello');
    expect(noteIdFromFilename('my note.md')).toBe('my note');
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

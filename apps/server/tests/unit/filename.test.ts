import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizeFilename, resolveFilename, conflictFilename } from '../../src/sync/files.js';
import { createTestEnv, type TestEnv } from '../helpers/setup.js';
import { getDb } from '../../src/db/index.js';
import { upsertNote } from '../../src/db/notes.js';

describe('sanitizeFilename', () => {
  it('passes through normal filenames', () => {
    expect(sanitizeFilename('my note.md')).toBe('my note.md');
  });

  it('strips path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd.md')).toBe('etcpasswd.md');
  });

  it('strips slashes', () => {
    expect(sanitizeFilename('path/to/file.md')).toBe('pathtofile.md');
    expect(sanitizeFilename('path\\to\\file.md')).toBe('pathtofile.md');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('test\x00\x01\x1f.md')).toBe('test.md');
  });

  it('strips Windows-reserved characters', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.md')).toBe('abcdefgh.md');
  });

  it('does not truncate long names', () => {
    const long = 'a'.repeat(300) + '.md';
    const result = sanitizeFilename(long);
    expect(result).toBe('a'.repeat(300) + '.md');
  });

  it('adds .md extension if missing', () => {
    expect(sanitizeFilename('note')).toBe('note.md');
  });

  it('preserves .md extension', () => {
    expect(sanitizeFilename('note.md')).toBe('note.md');
  });

  it('falls back to Untitled.md for empty input', () => {
    expect(sanitizeFilename('')).toBe('Untitled.md');
    expect(sanitizeFilename('.md')).toBe('Untitled.md');
  });

  it('preserves dot-only names', () => {
    expect(sanitizeFilename('...')).toBe('..md');
  });
});

describe('resolveFilename', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns the filename if no collision', () => {
    const db = getDb();
    expect(resolveFilename(db, 'test.md', 'uuid-1')).toBe('test.md');
  });

  it('appends counter on collision with different UUID', () => {
    const db = getDb();
    upsertNote(db, 'uuid-other', 'test.md', 'hash1', Date.now());

    expect(resolveFilename(db, 'test.md', 'uuid-1')).toBe('test (2).md');
  });

  it('does not collide with own UUID', () => {
    const db = getDb();
    upsertNote(db, 'uuid-1', 'test.md', 'hash1', Date.now());

    expect(resolveFilename(db, 'test.md', 'uuid-1')).toBe('test.md');
  });

  it('increments counter for multiple collisions', () => {
    const db = getDb();
    upsertNote(db, 'uuid-a', 'test.md', 'h1', Date.now());
    upsertNote(db, 'uuid-b', 'test (2).md', 'h2', Date.now());

    expect(resolveFilename(db, 'test.md', 'uuid-c')).toBe('test (3).md');
  });
});

describe('conflictFilename', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('creates conflict filename with date', () => {
    const db = getDb();
    const result = conflictFilename(db, 'note.md', 'uuid-1');
    const dateStr = new Date().toISOString().split('T')[0];
    expect(result).toBe(`note (conflict ${dateStr}).md`);
  });

  it('appends counter when conflict name already taken', () => {
    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];
    upsertNote(db, 'uuid-x', `note (conflict ${dateStr}).md`, 'h1', Date.now());

    const result = conflictFilename(db, 'note.md', 'uuid-1');
    expect(result).toBe(`note (conflict ${dateStr} 2).md`);
  });
});

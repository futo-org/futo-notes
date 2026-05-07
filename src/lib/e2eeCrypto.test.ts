/**
 * Tests for the V1↔V2 note frame round-trip in the E2EE blob format.
 * V1 is the legacy `[len][filename][content]` frame; V2 is the
 * versioned `[2][len][path][content]` frame introduced for folder
 * support. Both must round-trip cleanly through `unpackNote`.
 */

import { describe, it, expect } from 'vitest';
import { packNote, packNoteV1, unpackNote, NOTE_FRAME_V2 } from './e2eeCrypto';

describe('packNote / unpackNote (V2)', () => {
  it('round-trips a flat filename', () => {
    const blob = packNote('hello.md', 'world');
    expect(blob[0]).toBe(NOTE_FRAME_V2);
    const out = unpackNote(blob);
    expect(out.filename).toBe('hello.md');
    expect(out.content).toBe('world');
  });

  it('round-trips a nested path', () => {
    const blob = packNote('Specs/folder-support.md', '# Folders\n');
    const out = unpackNote(blob);
    expect(out.filename).toBe('Specs/folder-support.md');
    expect(out.content).toBe('# Folders\n');
  });

  it('handles deep paths', () => {
    const blob = packNote('a/b/c/d/leaf.md', 'deep');
    const out = unpackNote(blob);
    expect(out.filename).toBe('a/b/c/d/leaf.md');
    expect(out.content).toBe('deep');
  });

  it('handles unicode in path and content', () => {
    const blob = packNote('Notes/café ☕.md', 'こんにちは');
    const out = unpackNote(blob);
    expect(out.filename).toBe('Notes/café ☕.md');
    expect(out.content).toBe('こんにちは');
  });

  it('handles empty content', () => {
    const blob = packNote('empty.md', '');
    const out = unpackNote(blob);
    expect(out.filename).toBe('empty.md');
    expect(out.content).toBe('');
  });
});

describe('unpackNote V1 fallback', () => {
  it('decodes a V1-packed blob (legacy frame)', () => {
    const blob = packNoteV1('legacy.md', 'hello');
    expect(blob[0]).toBe(0x00);
    const out = unpackNote(blob);
    expect(out.filename).toBe('legacy.md');
    expect(out.content).toBe('hello');
  });

  it('treats a V1 blob as a root-level note (no folder path)', () => {
    const blob = packNoteV1('root.md', 'body');
    const out = unpackNote(blob);
    expect(out.filename).toBe('root.md');
    expect(out.filename.includes('/')).toBe(false);
  });
});

describe('unpackNote rejects malformed input', () => {
  it('throws on empty blob', () => {
    expect(() => unpackNote(new Uint8Array(0))).toThrow();
  });
  it('throws on unknown version byte', () => {
    const bad = new Uint8Array([0x05, 0, 0, 0, 4, 0x66, 0x6f, 0x6f, 0x2e, 0x6d, 0x64]);
    expect(() => unpackNote(bad)).toThrow(/unknown note frame version/);
  });
  it('throws on truncated v2 path', () => {
    // version=2, length=10, but only 4 bytes of path follow
    const bad = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x0a, 0x66, 0x6f, 0x6f, 0x2e]);
    expect(() => unpackNote(bad)).toThrow();
  });
});

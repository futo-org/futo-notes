import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createNodeFS, type TestPlatformFS } from './__test__/nodeFS';

function platformFSContractTests(name: string, createFS: () => TestPlatformFS) {
  describe(`PlatformFS contract: ${name}`, () => {
    let fs: TestPlatformFS;

    beforeEach(() => {
      fs = createFS();
      fs._reset();
    });

    afterAll(() => {
      fs._cleanup();
    });

    // ── Notes CRUD ──────────────────────────────────────

    it('listNoteFiles returns empty initially', async () => {
      expect(await fs.listNoteFiles()).toEqual([]);
    });

    it('writeNote + readNote round-trip', async () => {
      await fs.writeNote('test', 'hello world');
      expect(await fs.readNote('test')).toBe('hello world');
    });

    it('writeNote returns mtime', async () => {
      const mtime = await fs.writeNote('test', 'content');
      expect(typeof mtime).toBe('number');
      expect(mtime).toBeGreaterThan(0);
    });

    it('listNoteFiles includes written notes', async () => {
      await fs.writeNote('alpha', 'a');
      await fs.writeNote('beta', 'b');
      const files = await fs.listNoteFiles();
      const names = files.map((f) => f.name).sort();
      expect(names).toEqual(['alpha.md', 'beta.md']);
    });

    it('noteExists returns true for existing, false for missing', async () => {
      expect(await fs.noteExists('nope')).toBe(false);
      await fs.writeNote('yep', 'exists');
      expect(await fs.noteExists('yep')).toBe(true);
    });

    it('deleteNoteFile removes note', async () => {
      await fs.writeNote('doomed', 'bye');
      await fs.deleteNoteFile('doomed');
      expect(await fs.noteExists('doomed')).toBe(false);
    });

    // The real contract: a missing note reads as "" on every impl (Tauri
    // notes_read over futo-notes-model::read_note, web.ts, and this nodeFS
    // stand-in). Existence is a separate question — ask noteExists(). A caller
    // must NEVER infer "deleted" from a throw; the sync path's deleted-open-note
    // handling branches on the sync summary instead (F4).
    it('readNote returns "" for nonexistent (never throws)', async () => {
      expect(await fs.readNote('missing')).toBe('');
    });

    it('mtime preservation via modifiedAtMs', async () => {
      const targetMs = 1700000000000;
      const returnedMtime = await fs.writeNote('timed', 'content', targetMs);
      // File system mtime may have limited precision, allow 1s tolerance
      expect(Math.abs(returnedMtime - targetMs)).toBeLessThan(1000);

      const files = await fs.listNoteFiles();
      const timedFile = files.find((f) => f.name === 'timed.md');
      expect(timedFile).toBeDefined();
      expect(Math.abs(timedFile!.mtime - targetMs)).toBeLessThan(1000);
    });

    // ── AppData CRUD ────────────────────────────────────

    it('readAppData returns null for missing', async () => {
      expect(await fs.readAppData('.nonexistent.json')).toBeNull();
    });

    it('writeAppData + readAppData round-trip', async () => {
      await fs.writeAppData('.prefs.json', '{"key":"value"}');
      expect(await fs.readAppData('.prefs.json')).toBe('{"key":"value"}');
    });

    it('deleteAppData removes file', async () => {
      await fs.writeAppData('.temp.json', 'data');
      await fs.deleteAppData('.temp.json');
      expect(await fs.readAppData('.temp.json')).toBeNull();
    });

    it('listAppData returns files in subdirectory', async () => {
      await fs.writeAppData('subdir/a.txt', 'a');
      await fs.writeAppData('subdir/b.txt', 'b');
      const files = (await fs.listAppData('subdir')).sort();
      expect(files).toEqual(['a.txt', 'b.txt']);
    });

    it('listAppData returns empty for nonexistent dir', async () => {
      expect(await fs.listAppData('nope')).toEqual([]);
    });

    // ── Create / rename collision resolution ────────────
    // The double owns the `-2`/`-3` collision rule that production gets from
    // Rust `get_unique_note_id` (web/test have no Rust core). These pin its
    // resolution so it can't silently drift from the Rust rule (C3).

    it('createNote writes content atomically and returns id + mtime', async () => {
      const { id, mtime } = await fs.createNote('', 'Note', '# hi\nbody');
      expect(id).toBe('Note');
      expect(mtime).toBeGreaterThan(0);
      expect(await fs.readNote('Note')).toBe('# hi\nbody');
    });

    it('createNote suffixes -2/-3 on collision', async () => {
      expect((await fs.createNote('', 'note', 'a')).id).toBe('note');
      expect((await fs.createNote('', 'note', 'b')).id).toBe('note-2');
      expect((await fs.createNote('', 'note', 'c')).id).toBe('note-3');
    });

    it('renameNote suffixes when the destination is a distinct note', async () => {
      await fs.writeNote('a', 'A');
      await fs.writeNote('b', 'B');
      expect(await fs.renameNote('a', 'b')).toBe('b-2');
      expect(await fs.readNote('b')).toBe('B'); // distinct note untouched
    });

    // C3: a case-only rename with ONLY the source present. Rust `rename_note`
    // keeps the requested case ('note' → 'Note'). The double follows the host
    // filesystem, so it matches Rust on a case-SENSITIVE host; on a
    // case-INSENSITIVE host `noteExists('Note')` sees the source and it resolves
    // 'Note-2' — a KNOWN divergence (the double must NOT re-implement Rust's
    // case-fold rule; that would reintroduce the very drift this packet
    // deletes). Pinned here so a change to the double's resolution is caught.
    it('renameNote case-only rename matches Rust on a case-sensitive host', async () => {
      await fs.writeNote('__probe', 'x');
      const caseInsensitive = await fs.noteExists('__PROBE');
      await fs.deleteNoteFile('__probe');

      await fs.writeNote('note', 'body');
      const finalId = await fs.renameNote('note', 'Note');
      if (caseInsensitive) {
        expect(finalId).toBe('Note-2'); // documented divergence from Rust
      } else {
        expect(finalId).toBe('Note'); // matches Rust rename_note
        expect(await fs.readNote('Note')).toBe('body');
      }
    });

    // ── Metadata ────────────────────────────────────────

    it('getAppVersion returns a string', async () => {
      const version = await fs.getAppVersion();
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });

    it('getPlatformName returns a string', () => {
      const name = fs.getPlatformName();
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });
  });
}

// Run against nodeFS
platformFSContractTests('nodeFS', createNodeFS);

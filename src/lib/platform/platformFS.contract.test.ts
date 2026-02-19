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

    it('readNote throws for nonexistent', async () => {
      await expect(fs.readNote('missing')).rejects.toThrow();
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

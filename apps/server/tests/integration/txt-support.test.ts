import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
// contentHash not needed for current tests
import { convertTxtFiles, listNoteFiles } from '../../src/sync/files.js';
import path from 'node:path';

describe('.txt → .md conversion', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = createTestEnv();
    await setupAndLogin(env.app);
    mkdirSync(env.notesDir, { recursive: true });
  });

  afterEach(() => env.cleanup());

  it('converts .txt files to .md', () => {
    writeFileSync(path.join(env.notesDir, 'groceries.txt'), 'milk\neggs');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('groceries.md');
    expect(files).not.toContain('groceries.txt');
  });

  it('handles collision with existing .md file', () => {
    writeFileSync(path.join(env.notesDir, 'note.md'), 'md content');
    writeFileSync(path.join(env.notesDir, 'note.txt'), 'txt content');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('note.md');
    expect(files).toContain('note (imported).md');
    expect(files).not.toContain('note.txt');
  });

  it('ignores .csv and other non-txt/md files', () => {
    writeFileSync(path.join(env.notesDir, 'data.csv'), 'a,b,c');
    writeFileSync(path.join(env.notesDir, 'script.js'), 'console.log()');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('data.csv');
    expect(files).toContain('script.js');
    // No .md files created from non-txt
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('listNoteFiles converts .txt before listing', () => {
    writeFileSync(path.join(env.notesDir, 'note-a.md'), 'a');
    writeFileSync(path.join(env.notesDir, 'note-b.txt'), 'b');

    const files = listNoteFiles(env.notesDir);
    expect(files).toContain('note-a.md');
    expect(files).toContain('note-b.md');
    expect(files).toHaveLength(2);
  });

  it('listNoteFiles converts .txt and returns only .md', () => {
    writeFileSync(path.join(env.notesDir, 'dropped-note.txt'), 'dropped content');
    writeFileSync(path.join(env.notesDir, 'existing.md'), 'existing content');

    // listNoteFiles triggers conversion, so both should appear as .md
    const files = listNoteFiles(env.notesDir).sort();
    expect(files).toEqual(['dropped-note.md', 'existing.md']);

    // Verify on disk
    const diskFiles = readdirSync(env.notesDir).sort();
    expect(diskFiles).toContain('dropped-note.md');
    expect(diskFiles).toContain('existing.md');
    expect(diskFiles).not.toContain('dropped-note.txt');
  });
});

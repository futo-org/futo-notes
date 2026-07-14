import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeAtomicText, type AtomicWriteFS } from './atomicWrite';

function createNodeFSAdapter(): AtomicWriteFS {
  return {
    writeTextFile: (path, content) => fs.writeFile(path, content, 'utf-8'),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    mkdir: (path, options) => fs.mkdir(path, options),
    remove: (path) => fs.unlink(path),
  };
}

describe('writeAtomicText', () => {
  let tmpDir: string;
  let adapter: AtomicWriteFS;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-atomic-test-'));
    adapter = createNodeFSAdapter();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new file with correct content', async () => {
    const filePath = path.join(tmpDir, 'hello.md');
    await writeAtomicText(filePath, 'hello world', adapter);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('replaces existing file content atomically', async () => {
    const filePath = path.join(tmpDir, 'replace.md');
    await fs.writeFile(filePath, 'original', 'utf-8');
    await writeAtomicText(filePath, 'replaced', adapter);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('replaced');
  });

  it('creates parent directory if missing', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'nested.md');
    await writeAtomicText(filePath, 'deep content', adapter);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('deep content');
  });

  it('leaves no temp files on success', async () => {
    const filePath = path.join(tmpDir, 'clean.md');
    await writeAtomicText(filePath, 'content', adapter);
    const entries = await fs.readdir(tmpDir);
    const temps = entries.filter((e) => e.startsWith('.sf-tmp-'));
    expect(temps).toEqual([]);
  });

  it('handles concurrent writes to different files', async () => {
    const files = Array.from({ length: 10 }, (_, i) => path.join(tmpDir, `concurrent-${i}.md`));
    await Promise.all(files.map((f, i) => writeAtomicText(f, `content-${i}`, adapter)));
    for (let i = 0; i < files.length; i++) {
      const content = await fs.readFile(files[i], 'utf-8');
      expect(content).toBe(`content-${i}`);
    }
  });

  it('preserves Unicode content exactly', async () => {
    const filePath = path.join(tmpDir, 'unicode.md');
    const unicode =
      '# Hello \u4e16\u754c \ud83c\udf0d\n\nCaf\u00e9 \u00fc\u00f6\u00e4 \u2603\ufe0f \u2764\ufe0f\u200d\ud83d\udd25';
    await writeAtomicText(filePath, unicode, adapter);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe(unicode);
  });

  it('handles empty content', async () => {
    const filePath = path.join(tmpDir, 'empty.md');
    await writeAtomicText(filePath, '', adapter);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('');
  });

  it('throws on invalid path (no parent)', async () => {
    await expect(writeAtomicText('/', 'x', adapter)).rejects.toThrow('invalid file path');
  });

  it('cleans up temp file on write failure', async () => {
    const filePath = path.join(tmpDir, 'fail.md');
    const failingAdapter: AtomicWriteFS = {
      ...adapter,
      async writeTextFile() {
        throw new Error('disk full');
      },
    };
    await expect(writeAtomicText(filePath, 'content', failingAdapter)).rejects.toThrow('disk full');

    const entries = await fs.readdir(tmpDir);
    const temps = entries.filter((e) => e.startsWith('.sf-tmp-'));
    expect(temps).toEqual([]);
  });

  it('retries once when rename fails with a not-found error (temp yanked)', async () => {
    const filePath = path.join(tmpDir, 'race.md');
    let renameCalls = 0;
    let writeCalls = 0;

    const raceAdapter: AtomicWriteFS = {
      ...adapter,
      async writeTextFile(p: string, content: string) {
        writeCalls++;
        await adapter.writeTextFile(p, content);
      },
      async rename(oldPath: string, newPath: string) {
        renameCalls++;
        if (renameCalls === 1) {
          throw new Error('No such file or directory (os error 2)');
        }
        await adapter.rename(oldPath, newPath);
      },
    };

    await writeAtomicText(filePath, 'recovered content', raceAdapter);

    expect(renameCalls).toBe(2);
    expect(writeCalls).toBe(2);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('recovered content');
  });

  it('handles concurrent writes to the same file without throwing', async () => {
    const filePath = path.join(tmpDir, 'same-target.md');
    await Promise.all([
      writeAtomicText(filePath, 'a', adapter),
      writeAtomicText(filePath, 'b', adapter),
    ]);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(['a', 'b']).toContain(content);
    const entries = await fs.readdir(tmpDir);
    const temps = entries.filter((e) => e.startsWith('.sf-tmp-'));
    expect(temps).toEqual([]);
  });

  it('propagates rename failure and cleans up temp', async () => {
    const filePath = path.join(tmpDir, 'rename-fail.md');
    let writtenTmpPath: string | null = null;

    const failRenameAdapter: AtomicWriteFS = {
      ...adapter,
      async writeTextFile(p: string, content: string) {
        writtenTmpPath = p;
        await adapter.writeTextFile(p, content);
      },
      async rename() {
        throw new Error('rename failed');
      },
      async remove(p: string) {
        await adapter.remove!(p);
      },
    };

    await expect(writeAtomicText(filePath, 'content', failRenameAdapter)).rejects.toThrow(
      'rename failed',
    );

    expect(writtenTmpPath).not.toBeNull();
    expect(fsSync.existsSync(writtenTmpPath!)).toBe(false);
  });
});

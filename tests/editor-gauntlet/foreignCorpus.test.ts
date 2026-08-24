import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ForeignCorpusLoader } from './foreignCorpus';

const scratchDirs: string[] = [];

async function fixture(contents: string, gzip = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'futo-editor-corpus-test-'));
  scratchDirs.push(directory);
  const file = path.join(directory, gzip ? 'corpus.jsonl.gz' : 'corpus.jsonl');
  await writeFile(file, gzip ? gzipSync(contents) : contents);
  return file;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('ForeignCorpusLoader', () => {
  it('streams only bodies with opaque ordinals and exactly accounts a modulo shard', async () => {
    const file = await fixture(
      [
        JSON.stringify({ body: 'zero', title: 'must-not-leak', content_hash: 'secret-zero' }),
        '{not-json',
        JSON.stringify({ title: 'missing-body' }),
        JSON.stringify({ body: 'three', source_url: 'https://must-not-leak.invalid' }),
        JSON.stringify({ body: 'four' }),
      ].join('\n'),
    );
    const loader = new ForeignCorpusLoader(file, { shard: { index: 0, count: 2 } });

    const notes = [];
    for await (const note of loader) notes.push(note);

    expect(notes).toEqual([
      { ordinal: 0, source: 'zero' },
      { ordinal: 4, source: 'four' },
    ]);
    expect(JSON.stringify({ shard: loader.shard, corpus: loader.accounting })).not.toMatch(
      /must-not-leak|secret-zero|source_url/,
    );
    expect(loader.accounting).toEqual({
      recordsSeen: 5,
      selectedRecords: 3,
      selectedValidNotes: 2,
      selectedInvalidJson: 0,
      selectedMissingBody: 1,
      yieldedNotes: 2,
      omittedByLimit: 0,
      reachedEof: true,
    });
  });

  it('reads gzip input to EOF and explicitly accounts notes omitted by a smoke limit', async () => {
    const file = await fixture(
      `${JSON.stringify({ body: 'one' })}\n${JSON.stringify({ body: 'two' })}\n`,
      true,
    );
    const loader = new ForeignCorpusLoader(file, { maxNotes: 1 });

    const notes = [];
    for await (const note of loader) notes.push(note);

    expect(notes).toEqual([{ ordinal: 0, source: 'one' }]);
    expect(loader.accounting).toMatchObject({
      recordsSeen: 2,
      selectedRecords: 2,
      selectedValidNotes: 2,
      yieldedNotes: 1,
      omittedByLimit: 1,
      reachedEof: true,
    });
  });

  it('accounts malformed selected records on exactly one shard', async () => {
    const file = await fixture('{bad-json\n');
    const shardZero = new ForeignCorpusLoader(file, { shard: { index: 0, count: 2 } });
    const shardOne = new ForeignCorpusLoader(file, { shard: { index: 1, count: 2 } });

    for await (const _note of shardZero) {
      // No valid notes.
    }
    for await (const _note of shardOne) {
      // No selected notes.
    }

    expect(shardZero.accounting.selectedInvalidJson).toBe(1);
    expect(shardOne.accounting.selectedInvalidJson).toBe(0);
    expect(shardZero.accounting.selectedRecords + shardOne.accounting.selectedRecords).toBe(1);
  });

  it('rejects invalid shard configurations and a second consumption', async () => {
    const file = await fixture(`${JSON.stringify({ body: '' })}\n`);
    expect(() => new ForeignCorpusLoader(file, { shard: { index: 2, count: 2 } })).toThrow(
      /shard index/,
    );
    const loader = new ForeignCorpusLoader(file);
    for await (const _note of loader) {
      // Consume once.
    }
    await expect(async () => {
      for await (const _note of loader) {
        // A second read must fail rather than duplicate evidence.
      }
    }).rejects.toThrow(/one-shot/);
  });
});

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

import type { ForeignNote } from './foreignPreservation';

interface CorpusRecord {
  body?: unknown;
}

export interface ForeignCorpusShard {
  /** Zero-based shard index. */
  index: number;
  count: number;
}

export interface ForeignCorpusAccounting {
  recordsSeen: number;
  selectedRecords: number;
  selectedValidNotes: number;
  selectedInvalidJson: number;
  selectedMissingBody: number;
  yieldedNotes: number;
  omittedByLimit: number;
  reachedEof: boolean;
}

export interface ForeignCorpusOptions {
  shard?: ForeignCorpusShard;
  /** Smoke-only. The loader still reads to EOF and accounts for every omitted note. */
  maxNotes?: number;
}

/** SHA-256 of the bytes on disk (compressed bytes for `.gz` inputs). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function validateOptions(options: ForeignCorpusOptions): Required<ForeignCorpusOptions> {
  const shard = options.shard ?? { index: 0, count: 1 };
  if (!Number.isInteger(shard.count) || shard.count < 1) {
    throw new Error('foreign corpus shard count must be a positive integer');
  }
  if (!Number.isInteger(shard.index) || shard.index < 0 || shard.index >= shard.count) {
    throw new Error('foreign corpus shard index must be an integer within the shard count');
  }
  const maxNotes = options.maxNotes ?? Number.POSITIVE_INFINITY;
  if (!(maxNotes === Number.POSITIVE_INFINITY || (Number.isInteger(maxNotes) && maxNotes >= 0))) {
    throw new Error('foreign corpus maxNotes must be a non-negative integer');
  }
  return { shard, maxNotes };
}

/**
 * Streaming, one-shot corpus reader. It exposes only an opaque record ordinal and body to the
 * runner: titles, hashes, URLs, and every other source identifier stay outside the gauntlet.
 */
export class ForeignCorpusLoader implements AsyncIterable<ForeignNote> {
  readonly shard: ForeignCorpusShard;
  readonly maxNotes: number | null;
  readonly accounting: ForeignCorpusAccounting = {
    recordsSeen: 0,
    selectedRecords: 0,
    selectedValidNotes: 0,
    selectedInvalidJson: 0,
    selectedMissingBody: 0,
    yieldedNotes: 0,
    omittedByLimit: 0,
    reachedEof: false,
  };

  private consumed = false;

  constructor(
    private readonly path: string,
    options: ForeignCorpusOptions = {},
  ) {
    const validated = validateOptions(options);
    this.shard = validated.shard;
    this.maxNotes = Number.isFinite(validated.maxNotes) ? validated.maxNotes : null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ForeignNote> {
    if (this.consumed) throw new Error('foreign corpus loader is one-shot');
    this.consumed = true;

    const file = createReadStream(this.path);
    const input = this.path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
    const lines = createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        const ordinal = this.accounting.recordsSeen;
        this.accounting.recordsSeen += 1;
        if (ordinal % this.shard.count !== this.shard.index) continue;
        this.accounting.selectedRecords += 1;

        let record: CorpusRecord;
        try {
          record = JSON.parse(line) as CorpusRecord;
        } catch {
          this.accounting.selectedInvalidJson += 1;
          continue;
        }
        if (typeof record.body !== 'string') {
          this.accounting.selectedMissingBody += 1;
          continue;
        }

        this.accounting.selectedValidNotes += 1;
        if (this.maxNotes !== null && this.accounting.yieldedNotes >= this.maxNotes) {
          this.accounting.omittedByLimit += 1;
          continue;
        }
        this.accounting.yieldedNotes += 1;
        yield { ordinal, source: record.body };
      }
      this.accounting.reachedEof = true;
    } finally {
      lines.close();
      file.destroy();
    }
  }
}

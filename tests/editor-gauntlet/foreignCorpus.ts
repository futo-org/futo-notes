import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

import type { ForeignNote } from './foreignPreservation';

interface CorpusRecord {
  content_hash?: unknown;
  title?: unknown;
  body?: unknown;
}

export async function loadForeignNotes(path: string, limit: number): Promise<ForeignNote[]> {
  const file = createReadStream(path);
  const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const notes: ForeignNote[] = [];

  try {
    for await (const line of lines) {
      const record = JSON.parse(line) as CorpusRecord;
      if (typeof record.body !== 'string') throw new Error('foreign corpus record has no body');
      const fallbackId = typeof record.title === 'string' ? record.title : `note-${notes.length}`;
      const id = typeof record.content_hash === 'string' ? record.content_hash : fallbackId;
      notes.push({ id, source: record.body });
      if (notes.length >= limit) break;
    }
  } finally {
    lines.close();
    file.destroy();
  }

  return notes;
}

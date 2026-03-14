import fs from 'node:fs';
import path from 'node:path';
import { buildGraphDataFromEntries } from '../src/lib/supersearch/graphLayout';

interface ManifestChunk {
  chunk_id: number;
  uuid: string;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
}

interface ManifestPayload {
  dims: number;
  chunk_count: number;
  chunks: ManifestChunk[];
}

interface SyncState {
  uuidById: Record<string, string>;
}

function extractTags(content: string): string[] {
  const matches = content.match(/(^|\s)(#[a-zA-Z0-9/_-]+)/g) ?? [];
  return Array.from(new Set(matches.map((match) => match.trim())));
}

function previewOf(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^#.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function averageVectors(manifest: ManifestPayload, bytes: Buffer): Map<string, number[]> {
  const dims = manifest.dims;
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const byUuid = new Map<string, number[]>();
  const counts = new Map<string, number>();

  manifest.chunks.forEach((chunk, index) => {
    const current = byUuid.get(chunk.uuid) ?? new Array<number>(dims).fill(0);
    const offset = index * dims;
    for (let i = 0; i < dims; i++) {
      current[i] += all[offset + i];
    }
    byUuid.set(chunk.uuid, current);
    counts.set(chunk.uuid, (counts.get(chunk.uuid) ?? 0) + 1);
  });

  for (const [uuid, vector] of byUuid) {
    const count = counts.get(uuid) ?? 1;
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= count;
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }
  }

  return byUuid;
}

function main(): void {
  const vault = path.resolve(process.env.HOME ?? '', 'Documents/stonefruit-backup');
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, '.supersearch-manifest.json'), 'utf8')) as ManifestPayload;
  const sync = JSON.parse(fs.readFileSync(path.join(vault, '.sync-state-v1.json'), 'utf8')) as SyncState;
  const vectors = averageVectors(
    manifest,
    fs.readFileSync(path.join(vault, '.supersearch-vectors.bin')),
  );
  const idByUuid = new Map<string, string>(Object.entries(sync.uuidById).map(([id, uuid]) => [uuid, id]));

  const entries = Array.from(vectors.entries())
    .map(([uuid, vector]) => {
      const noteId = idByUuid.get(uuid) ?? uuid;
      const file = path.join(vault, `${noteId}.md`);
      if (!fs.existsSync(file)) return null;
      const content = fs.readFileSync(file, 'utf8');
      return {
        noteId,
        title: noteId,
        preview: previewOf(content),
        tags: extractTags(content),
        vector,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const graph = buildGraphDataFromEntries(entries);
  const clusterRows = graph.clusters.map((cluster) => ({
    label: cluster.label,
    size: cluster.noteIds.length,
    sampleNotes: cluster.noteIds.slice(0, 8),
  }));

  console.log(JSON.stringify(clusterRows, null, 2));
}

main();

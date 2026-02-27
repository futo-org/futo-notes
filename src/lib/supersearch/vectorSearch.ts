import { getFS, platformName } from '../platform';

export interface VectorSearchResult {
  uuid: string;
  chunkText: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

export async function vectorSearch(
  queryVector: Float32Array,
  topK: number,
): Promise<VectorSearchResult[]> {
  let raw: VectorSearchResult[];

  if (platformName === 'tauri') {
    const fs = getFS();
    if (!fs.supersearchQuery) {
      throw new Error('Native supersearch_query is unavailable on tauri platform');
    }

    const rows = await fs.supersearchQuery(Array.from(queryVector), topK * 2);
    raw = rows.map((r) => ({
      uuid: r.uuid,
      chunkText: r.chunkText,
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      score: r.score,
    }));
  } else {
    // Web: no vector search
    return [];
  }

  // Deduplicate: multiple chunks from same note -> keep best score
  const bestByUuid = new Map<string, VectorSearchResult>();
  for (const result of raw) {
    const existing = bestByUuid.get(result.uuid);
    if (!existing || result.score > existing.score) {
      bestByUuid.set(result.uuid, result);
    }
  }

  const deduplicated = Array.from(bestByUuid.values());
  deduplicated.sort((a, b) => b.score - a.score);
  return deduplicated.slice(0, topK);
}

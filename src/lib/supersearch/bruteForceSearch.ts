import { getFS } from '../platform';

export interface BruteForceResult {
  uuid: string;
  chunkText: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

interface ManifestChunk {
  chunk_id: number;
  uuid: string;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
}

interface Manifest {
  dims: number;
  chunk_count: number;
  chunks: ManifestChunk[];
}

let cachedVectors: Float32Array | null = null;
let cachedManifest: Manifest | null = null;

export async function loadArtifacts(): Promise<boolean> {
  const fs = getFS();
  try {
    const manifestRaw = await fs.readAppData('.supersearch-manifest.json');
    if (!manifestRaw) return false;
    cachedManifest = JSON.parse(manifestRaw) as Manifest;

    const binData = await fs.readBinaryAppData!('.supersearch-vectors.bin');
    if (!binData) return false;
    cachedVectors = new Float32Array(binData);
    return true;
  } catch {
    return false;
  }
}

export function clearCache(): void {
  cachedVectors = null;
  cachedManifest = null;
}

export function bruteForceSearch(
  queryVector: Float32Array,
  topK: number,
): BruteForceResult[] {
  if (!cachedVectors || !cachedManifest) return [];

  const { dims, chunks } = cachedManifest;
  const chunkCount = chunks.length;
  if (chunkCount === 0) return [];

  // Compute dot product (vectors are pre-normalized, so dot = cosine similarity)
  const scores: { index: number; score: number }[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const offset = i * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) {
      dot += queryVector[d] * cachedVectors[offset + d];
    }
    scores.push({ index: i, score: dot });
  }

  // Sort descending by score, take top-K
  scores.sort((a, b) => b.score - a.score);
  const topScores = scores.slice(0, topK);

  return topScores.map(({ index, score }) => {
    const chunk = chunks[index];
    return {
      uuid: chunk.uuid,
      chunkText: chunk.chunk_text,
      startOffset: chunk.start_offset,
      endOffset: chunk.end_offset,
      score,
    };
  });
}

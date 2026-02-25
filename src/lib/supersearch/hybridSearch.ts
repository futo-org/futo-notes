import type { SearchResultItem, NotePreview, SnippetSegment } from '../../types';
import type { VectorSearchResult } from './vectorSearch';

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merges keyword and vector ranked lists.
 * score(doc) = sum(1 / (K + rank_i(doc)))
 */
export function hybridSearch(
  keywordResults: SearchResultItem[],
  vectorResults: VectorSearchResult[],
  noteCache: Map<string, NotePreview>,
): SearchResultItem[] {
  const scores = new Map<string, number>();
  const snippets = new Map<string, SnippetSegment[] | null>();
  const noteMap = new Map<string, NotePreview>();

  // Score keyword results by rank
  for (let i = 0; i < keywordResults.length; i++) {
    const id = keywordResults[i].note.id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i));
    snippets.set(id, keywordResults[i].snippet);
    noteMap.set(id, keywordResults[i].note);
  }

  // Score vector results by rank, mapping UUID → note ID
  for (let i = 0; i < vectorResults.length; i++) {
    const uuid = vectorResults[i].uuid;
    // Vector results arrive with UUID; find matching note in cache by UUID or id
    let noteId: string | null = null;
    // Try direct lookup (uuid might be the note id)
    const note: NotePreview | undefined = noteCache.get(uuid);
    if (note) {
      noteId = note.id;
    } else {
      // Scan cache for a match — the caller should have mapped UUIDs already
      // Fall through: the note might not be in local cache yet
      continue;
    }

    if (!noteId) continue;

    scores.set(noteId, (scores.get(noteId) ?? 0) + 1 / (RRF_K + i));
    if (!noteMap.has(noteId)) {
      noteMap.set(noteId, note);
    }
    // If no keyword snippet exists for this note, create one from vector chunk
    if (!snippets.has(noteId) && vectorResults[i].chunkText) {
      const text = vectorResults[i].chunkText.slice(0, 120).replace(/\n/g, ' ');
      snippets.set(noteId, [{ text, highlight: false }]);
    }
  }

  // Sort by fused score descending
  const entries = Array.from(scores.entries());
  entries.sort((a, b) => b[1] - a[1]);

  const results: SearchResultItem[] = [];
  for (const [id] of entries) {
    const note = noteMap.get(id);
    if (!note) continue;
    results.push({
      note,
      snippet: snippets.get(id) ?? null,
    });
  }

  return results;
}

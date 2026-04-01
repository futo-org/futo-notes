import type { SearchResultItem, NotePreview } from '../types';

export const SERVER_SEARCH_TIMEOUT_MS = 10_000;
const RRF_K = 60;

export interface ServerSearchResponse {
  results: Array<{
    filename: string;
    snippet: string;
    score: number;
    source: 'keyword' | 'vector' | 'both';
  }>;
  timing: {
    keyword_ms: number;
    vector_ms: number;
    total_ms: number;
  };
  vector_enabled: boolean;
}

export interface ServerSearchResult {
  results: SearchResultItem[];
  semanticResults: SearchResultItem[];
  timing: {
    keyword: number;
    vector: number;
    total: number;
  };
}

export async function fetchServerSearchResults(
  serverUrl: string,
  token: string,
  query: string,
  signal?: AbortSignal,
): Promise<ServerSearchResponse> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), SERVER_SEARCH_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const url = `${serverUrl}/search?q=${encodeURIComponent(query)}&limit=20`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function mapServerResults(
  response: ServerSearchResponse,
  notes: NotePreview[],
): ServerSearchResult {
  const notesByFilename = new Map<string, NotePreview>();
  for (const note of notes) {
    notesByFilename.set(`${note.id}.md`, note);
    notesByFilename.set(`${note.id}.md.md`, note);
    notesByFilename.set(note.id, note);
  }

  const results: SearchResultItem[] = [];
  const semanticResults: SearchResultItem[] = [];
  for (const item of response.results) {
    const note =
      notesByFilename.get(item.filename) ??
      notesByFilename.get(stripMarkdownSuffixes(item.filename));
    if (!note) continue;
    const result: SearchResultItem = {
      note,
      snippet: item.snippet ? [{ text: item.snippet, highlight: false }] : null,
      source: item.source,
    };
    results.push(result);
    if (item.source === 'vector' || item.source === 'both') {
      semanticResults.push(result);
    }
  }

  return {
    results,
    semanticResults,
    timing: {
      keyword: response.timing.keyword_ms,
      vector: response.timing.vector_ms,
      total: response.timing.total_ms,
    },
  };
}

function stripMarkdownSuffixes(filename: string): string {
  return filename.replace(/(?:\.md)+$/i, '');
}

export function hasSemanticServerResults(serverResults: ServerSearchResult | null): boolean {
  return Boolean(serverResults && serverResults.semanticResults.length > 0);
}

export function fuseConnectedSearchResults(
  keywordResults: SearchResultItem[],
  serverResults: ServerSearchResult | null,
): SearchResultItem[] {
  const semanticResults = serverResults?.semanticResults ?? [];
  if (semanticResults.length === 0) {
    return keywordResults.map((result) => ({
      ...result,
      source: result.source ?? 'keyword',
    }));
  }

  const fusedScores = new Map<string, number>();
  const notes = new Map<string, NotePreview>();
  const snippets = new Map<string, SearchResultItem['snippet']>();
  const hasKeyword = new Set<string>();
  const hasSemantic = new Set<string>();

  for (let index = 0; index < keywordResults.length; index++) {
    const result = keywordResults[index];
    const noteId = result.note.id;
    fusedScores.set(noteId, (fusedScores.get(noteId) ?? 0) + 1 / (RRF_K + index + 1));
    notes.set(noteId, result.note);
    if (!snippets.has(noteId)) {
      snippets.set(noteId, result.snippet);
    }
    hasKeyword.add(noteId);
  }

  for (let index = 0; index < semanticResults.length; index++) {
    const result = semanticResults[index];
    const noteId = result.note.id;
    fusedScores.set(noteId, (fusedScores.get(noteId) ?? 0) + 1 / (RRF_K + index + 1));
    notes.set(noteId, result.note);
    if (!snippets.has(noteId) || snippets.get(noteId) === null) {
      snippets.set(noteId, result.snippet);
    }
    hasSemantic.add(noteId);
  }

  return Array.from(fusedScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([noteId]) => ({
      note: notes.get(noteId)!,
      snippet: snippets.get(noteId) ?? null,
      source: hasKeyword.has(noteId) && hasSemantic.has(noteId)
        ? 'both'
        : (hasKeyword.has(noteId) ? 'keyword' : 'vector'),
    }));
}

import MiniSearch from 'minisearch';
import type { SnippetSegment } from '../types';
import { getFS } from './platform';

// --- Types ---

export interface NoteDocument {
  id: string;
  title: string;
  headings: string;
  body: string;
  mtime: number;
}

export interface SearchHit {
  noteId: string;
  score: number;
  terms: string[];
  queryTerms: string[];
  match: Record<string, string[]>;
}

export interface AddDocInput {
  id: string;
  title: string;
  body: string;
  mtime: number;
}

// --- MiniSearch configuration ---

const MINISEARCH_OPTIONS = {
  fields: ['title', 'headings', 'body'],
  storeFields: ['title', 'body', 'mtime'],
  searchOptions: {
    boost: { title: 5, headings: 3, body: 1 },
    fuzzy: 0.2,
    prefix: true,
    boostDocument: (_id: string, _term: string, storedFields?: Record<string, unknown>) => {
      const mtime = storedFields?.mtime as number | undefined;
      if (!mtime) return 1;
      const daysSinceEdit = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
      return 1 + Math.max(0, 1 - daysSinceEdit / 30);
    },
  },
};

// --- State ---

let searchIndex: MiniSearch<NoteDocument> | null = null;
let mtimeMap: Record<string, number> = {};

// --- Persistence ---

const PERSIST_PATH = '.search-index-v1.json';
const PERSIST_VERSION = 1;

export async function loadPersistedIndex(): Promise<boolean> {
  try {
    const raw = await getFS().readAppData(PERSIST_PATH);
    if (!raw) return false;

    const data = JSON.parse(raw);
    if (data.version !== PERSIST_VERSION) return false;

    searchIndex = MiniSearch.loadJSON<NoteDocument>(data.indexJSON, MINISEARCH_OPTIONS);
    mtimeMap = data.mtimeMap || {};
    return true;
  } catch {
    return false;
  }
}

// Trailing-edge debounce. Safe to drop the last write: next launch
// rebuilds the index from file mtimes.
const PERSIST_DEBOUNCE_MS = 1_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight = false;
let persistQueued = false;

async function writeIndexNow(): Promise<void> {
  if (!searchIndex) return;
  try {
    const payload = JSON.stringify({
      version: PERSIST_VERSION,
      indexJSON: JSON.stringify(searchIndex),
      mtimeMap,
    });
    await getFS().writeAppData(PERSIST_PATH, payload);
  } catch (e) {
    console.warn('Failed to persist search index:', e);
  }
}

async function drainPersist(): Promise<void> {
  if (persistInFlight) {
    persistQueued = true;
    return;
  }
  persistInFlight = true;
  try {
    await writeIndexNow();
  } finally {
    persistInFlight = false;
    if (persistQueued) {
      persistQueued = false;
      void drainPersist();
    }
  }
}

export function persistIndex(): void {
  if (!searchIndex) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void drainPersist();
  }, PERSIST_DEBOUNCE_MS);
}

/** Force-flush any pending persist. Use before app exit / test teardown. */
export async function flushPersistIndex(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await drainPersist();
}

export function getMtimeMap(): Record<string, number> {
  return { ...mtimeMap };
}

// --- Helpers ---

export function extractHeadings(content: string): string {
  const lines = content.split('\n');
  const headings: string[] = [];
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m) headings.push(m[1].trim());
  }
  return headings.join(' ');
}

// --- Index operations ---

export function initSearchIndex(): void {
  searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
  mtimeMap = {};
}

export function addToSearchIndex(doc: AddDocInput): void {
  if (!searchIndex) {
    searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
  }
  try {
    searchIndex.discard(doc.id);
  } catch {
    // Entry didn't exist
  }
  const headings = extractHeadings(doc.body);
  searchIndex.add({ id: doc.id, title: doc.title, headings, body: doc.body, mtime: doc.mtime });
  mtimeMap[doc.id] = doc.mtime;
}

export function removeFromSearchIndex(id: string): void {
  if (!searchIndex) return;
  try {
    searchIndex.discard(id);
  } catch {
    // Entry didn't exist
  }
  delete mtimeMap[id];
}

export function isSearchIndexPopulated(): boolean {
  return searchIndex != null && searchIndex.documentCount > 0;
}

export function searchNotes(query: string): SearchHit[] {
  if (!searchIndex || !query.trim()) return [];
  const results = searchIndex.search(query);
  return results.map((r) => ({
    noteId: r.id as string,
    score: r.score,
    terms: r.terms,
    queryTerms: r.queryTerms,
    match: r.match,
  }));
}

export function clearSearchIndex(): void {
  searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
  mtimeMap = {};
}

// --- Stored fields access ---

export function getStoredBody(id: string): string | null {
  if (!searchIndex) return null;
  try {
    const stored = searchIndex.getStoredFields(id);
    if (!stored) return null;
    return (stored.body as string) ?? null;
  } catch {
    return null;
  }
}

// --- Snippet extraction ---

export function extractSnippet(hit: SearchHit): SnippetSegment[] {
  const body = getStoredBody(hit.noteId);
  if (!body) return [{ text: '', highlight: false }];

  const matchedTerms = hit.terms;
  if (matchedTerms.length === 0) {
    return [{ text: body.slice(0, 120).replace(/\n/g, ' ') + (body.length > 120 ? '...' : ''), highlight: false }];
  }

  // Find first occurrence of any matched term in body
  const bodyLower = body.toLowerCase();
  let bestPos = -1;
  let bestTerm = '';

  for (const term of matchedTerms) {
    const pos = bodyLower.indexOf(term.toLowerCase());
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
      bestTerm = term;
    }
  }

  // If match was title/headings-only (not in body), fall back to first 120 chars
  if (bestPos === -1) {
    const fallback = body.slice(0, 120).replace(/\n/g, ' ');
    return [{ text: fallback + (body.length > 120 ? '...' : ''), highlight: false }];
  }

  // Extract ~120-char window centered on match, snap to word boundaries
  const windowSize = 120;
  const halfWindow = Math.floor((windowSize - bestTerm.length) / 2);

  let start = Math.max(0, bestPos - halfWindow);
  let end = Math.min(body.length, bestPos + bestTerm.length + halfWindow);

  // Snap to word boundaries
  if (start > 0) {
    const spaceAfter = body.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < bestPos) {
      start = spaceAfter + 1;
    }
  }
  if (end < body.length) {
    const spaceBefore = body.lastIndexOf(' ', end);
    if (spaceBefore > bestPos + bestTerm.length) {
      end = spaceBefore;
    }
  }

  let snippetText = body.slice(start, end).replace(/\n/g, ' ');
  const prefix = start > 0 ? '...' : '';
  const suffix = end < body.length ? '...' : '';
  snippetText = prefix + snippetText + suffix;

  return buildHighlightedSegments(snippetText, matchedTerms);
}

export function buildHighlightedSegments(text: string, terms: string[]): SnippetSegment[] {
  if (terms.length === 0) return [{ text, highlight: false }];

  const textLower = text.toLowerCase();

  // Find all term positions
  const ranges: { start: number; end: number }[] = [];
  for (const term of terms) {
    const termLower = term.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < textLower.length) {
      const pos = textLower.indexOf(termLower, searchFrom);
      if (pos === -1) break;
      ranges.push({ start: pos, end: pos + termLower.length });
      searchFrom = pos + 1;
    }
  }

  if (ranges.length === 0) return [{ text, highlight: false }];

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i].start <= last.end) {
      last.end = Math.max(last.end, ranges[i].end);
    } else {
      merged.push(ranges[i]);
    }
  }

  // Build alternating segments
  const segments: SnippetSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (cursor < range.start) {
      segments.push({ text: text.slice(cursor, range.start), highlight: false });
    }
    segments.push({ text: text.slice(range.start, range.end), highlight: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlight: false });
  }

  return segments;
}

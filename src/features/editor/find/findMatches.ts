import { SearchCursor } from '@codemirror/search';
import type { Text } from '@codemirror/state';

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindMatchReport {
  query: string;
  current: number;
  total: number;
  label: string;
}

const normalizeCase = (text: string): string => text.toLowerCase();

export function findMatches(doc: Text, query: string, from = 0, to = doc.length): FindMatch[] {
  if (!query) return [];
  return Array.from(new SearchCursor(doc, query, from, to, normalizeCase), ({ from, to }) => ({
    from,
    to,
  }));
}

export function findCurrentMatchIndex(
  matches: readonly FindMatch[],
  selection: { from: number; to: number },
): number {
  if (matches.length === 0) return -1;
  const exact = matches.findIndex(
    (match) => match.from === selection.from && match.to === selection.to,
  );
  if (exact >= 0) return exact;
  const next = matches.findIndex((match) => match.from >= selection.from);
  return next >= 0 ? next : 0;
}

export function wrapFindMatchIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return ((index % length) + length) % length;
}

export function createFindMatchReport(
  query: string,
  currentIndex: number,
  total: number,
): FindMatchReport {
  if (total === 0) return { query, current: 0, total: 0, label: '0' };
  const current = currentIndex + 1;
  return { query, current, total, label: `${current} of ${total}` };
}

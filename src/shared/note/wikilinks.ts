export const WIKILINK_RE = /\[\[((?:(?!\]\])[^\n])+)\]\]/g;

function components(id: string): string[] {
  return id.split('/');
}

export function noteIdLeaf(id: string): string {
  const parts = components(id);
  return parts[parts.length - 1];
}

export function shortestUniqueSuffix(targetId: string, allIds: Iterable<string>): string {
  const target = components(targetId);
  const others: string[][] = [];
  for (const id of allIds) {
    if (id === targetId) continue;
    others.push(components(id));
  }
  for (let i = target.length - 1; i >= 0; i--) {
    const suffixLen = target.length - i;
    const candidate = target.slice(i);
    let collides = false;
    for (const other of others) {
      if (other.length < suffixLen) continue;
      const otherSuffix = other.slice(other.length - suffixLen);
      if (otherSuffix.length !== suffixLen) continue;
      let same = true;
      for (let j = 0; j < suffixLen; j++) {
        if (otherSuffix[j] !== candidate[j]) {
          same = false;
          break;
        }
      }
      if (same) {
        collides = true;
        break;
      }
    }
    if (!collides) return candidate.join('/');
  }
  return targetId;
}

/**
 * Resolve a wikilink target to a note id: an exact id wins outright, otherwise
 * the target must name the trailing path components of exactly ONE note.
 * Ambiguous or absent targets are broken links (`null`).
 *
 * "`target` is a component-aligned suffix of `id`" is tested as "`id` ends with
 * `target` at a `/` boundary" rather than by splitting both — every wikilink
 * decoration resolves against every note id in the vault on every render, and
 * splitting there allocated an array per id per link per frame.
 */
export function resolveWikilink(target: string, allIds: Iterable<string>): string | null {
  if (target === '') return null;
  let onlyMatch: string | null = null;
  let matches = 0;
  for (const id of allIds) {
    if (id === target) return target;
    if (
      id.length > target.length &&
      id.endsWith(target) &&
      id[id.length - target.length - 1] === '/'
    ) {
      matches += 1;
      onlyMatch = id;
    }
  }
  return matches === 1 ? onlyMatch : null;
}

/** Answers the two lookups above without rescanning the note list per call. */
export interface WikilinkIndex {
  resolve(target: string): string | null;
  displaySuffix(id: string): string;
}

/**
 * One pass over the note ids, keying every path suffix to the ids that end with
 * it, so a caller resolving many links pays the vault once instead of once per
 * link. A repeated id counts twice for `resolve` (which treats two matches as
 * ambiguous) but once for `displaySuffix` (which excludes the id itself, both
 * copies of it) — the two rules disagree there, so each gets its own tally.
 */
export function buildWikilinkIndex(allIds: Iterable<string>): WikilinkIndex {
  const ids = new Set<string>();
  const bySuffix = new Map<string, { id: string; matches: number; owners: number }>();

  for (const id of allIds) {
    const firstSeen = !ids.has(id);
    ids.add(id);
    const parts = components(id);
    for (let index = parts.length - 1; index >= 0; index--) {
      const suffix = parts.slice(index).join('/');
      const entry = bySuffix.get(suffix);
      if (!entry) {
        bySuffix.set(suffix, { id, matches: 1, owners: 1 });
        continue;
      }
      entry.matches += 1;
      if (firstSeen) entry.owners += 1;
    }
  }

  return {
    resolve(target) {
      if (target === '') return null;
      if (ids.has(target)) return target;
      const entry = bySuffix.get(target);
      return entry?.matches === 1 ? entry.id : null;
    },
    displaySuffix(id) {
      // An owner count of 1 means only an indexed id carries the suffix; for an
      // id the index never saw, that 1 is somebody else and proves nothing.
      if (!ids.has(id)) return shortestUniqueSuffix(id, ids);
      const parts = components(id);
      for (let index = parts.length - 1; index >= 0; index--) {
        const suffix = parts.slice(index).join('/');
        if (bySuffix.get(suffix)?.owners === 1) return suffix;
      }
      return id;
    },
  };
}

export interface WikilinkOccurrence {
  start: number;
  end: number;
  target: string;
}

export function findWikilinks(text: string): WikilinkOccurrence[] {
  const out: WikilinkOccurrence[] = [];
  const re = new RegExp(WIKILINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, target: m[1] });
  }
  return out;
}

export function rewriteWikilinks(
  text: string,
  oldId: string,
  newId: string,
  allIds: Iterable<string>,
): { text: string; rewrites: number } {
  const occurrences = findWikilinks(text);
  if (occurrences.length === 0) return { text, rewrites: 0 };
  const ids = Array.from(allIds);
  const ctx = ids.includes(oldId) ? ids : [...ids, oldId];
  let rewrites = 0;
  let cursor = 0;
  let out = '';
  for (const occ of occurrences) {
    const resolved = resolveWikilink(occ.target, ctx);
    out += text.slice(cursor, occ.start);
    if (resolved === oldId) {
      out += `[[${newId}]]`;
      rewrites++;
    } else {
      out += text.slice(occ.start, occ.end);
    }
    cursor = occ.end;
  }
  out += text.slice(cursor);
  return { text: out, rewrites };
}

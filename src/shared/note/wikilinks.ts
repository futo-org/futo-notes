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

export function resolveWikilink(target: string, allIds: Iterable<string>): string | null {
  if (target === '') return null;
  const ids: string[] = Array.from(allIds);
  if (ids.includes(target)) {
    return target;
  }
  if (!target.includes('/')) {
    const candidates = ids.filter((id) => noteIdLeaf(id) === target);
    if (candidates.length === 1) return candidates[0];
    return null; // ambiguous (or absent) — broken
  }
  const targetParts = components(target);
  const candidates: string[] = [];
  for (const id of ids) {
    const idParts = components(id);
    if (idParts.length < targetParts.length) continue;
    const tail = idParts.slice(idParts.length - targetParts.length);
    if (tail.join('/') === target) candidates.push(id);
  }
  if (candidates.length === 1) return candidates[0];
  return null;
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

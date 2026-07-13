/**
 * Wikilink resolution and display rules.
 *
 * On-disk format
 * --------------
 * Wikilinks are written as the **full path** without extension:
 *   `[[Specs/folder-support]]` — resolves to the note ID `Specs/folder-support`.
 *
 * Display
 * -------
 * Show the **shortest path suffix that is globally unique across the
 * note index**. If the bare filename is unique, show just the filename.
 * If it collides, prepend parent folders one at a time until the suffix
 * is globally unique.
 *
 * Resolution
 * ----------
 * - Full-path wikilinks resolve directly.
 * - Legacy bare-filename wikilinks resolve to the unique note with that
 *   filename if exactly one exists; otherwise treat as broken (do not
 *   silently pick a winner).
 *
 * Migration
 * ---------
 * Existing bare-filename wikilinks are left alone. New wikilinks
 * inserted by autocomplete and any wikilinks rewritten on move always
 * use the full path.
 */

/** Wikilink regex — matches `[[title]]`, allowing anything except `]]`
 *  or a newline inside the title. The capture group is the inner text. */
export const WIKILINK_RE = /\[\[((?:(?!\]\])[^\n])+)\]\]/g;

/** Split a note ID into path components (forward slashes). */
function components(id: string): string[] {
  return id.split('/');
}

/** Return the leaf (last component) of a note ID. */
export function noteIdLeaf(id: string): string {
  const parts = components(id);
  return parts[parts.length - 1];
}

/** Compute the shortest path-suffix of `targetId` that does not collide
 *  with any other ID in `allIds`. Returns `targetId` itself if no shorter
 *  suffix is unique (e.g. when two IDs are identical, which shouldn't
 *  happen but we don't want an infinite loop).
 *
 *  A "suffix" here is a tail-aligned slice of components: for ID
 *  `A/B/C`, candidates in order are `C`, `B/C`, `A/B/C`.
 */
export function shortestUniqueSuffix(targetId: string, allIds: Iterable<string>): string {
  const target = components(targetId);
  // Pre-compute every other ID's components once.
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
 * Resolve a wikilink target string to a note ID.
 *
 * - If `target` is a full path that exactly matches an ID, return that ID.
 * - If `target` is a bare filename and exactly one ID has that leaf,
 *   return that ID (legacy behavior).
 * - Otherwise return null (broken link).
 */
export function resolveWikilink(target: string, allIds: Iterable<string>): string | null {
  if (target === '') return null;
  const ids: string[] = Array.from(allIds);
  // Exact ID match — covers full paths and root-level bare filenames.
  if (ids.includes(target)) {
    return target;
  }
  // Bare filename: target has no `/`. Find candidates whose leaf matches.
  if (!target.includes('/')) {
    const candidates = ids.filter((id) => noteIdLeaf(id) === target);
    if (candidates.length === 1) return candidates[0];
    return null; // ambiguous (or absent) — broken
  }
  // Multi-component target that didn't match exactly. Try as a unique
  // path-suffix: if exactly one ID ends in the same components, accept.
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

/** Result of scanning a string for wikilinks. */
export interface WikilinkOccurrence {
  /** Start offset of the `[[`. */
  start: number;
  /** End offset (exclusive) past the `]]`. */
  end: number;
  /** The literal title text between `[[` and `]]`. */
  target: string;
}

/** Find all `[[...]]` occurrences in `text`. */
export function findWikilinks(text: string): WikilinkOccurrence[] {
  const out: WikilinkOccurrence[] = [];
  const re = new RegExp(WIKILINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, target: m[1] });
  }
  return out;
}

/**
 * Rewrite every wikilink in `text` whose target resolves to `oldId`
 * (per the resolution rules) so the on-disk text uses `newId`. Returns
 * the rewritten text and the count of rewrites.
 *
 * Used by the rewrite-on-move infrastructure when a note's ID changes.
 */
export function rewriteWikilinks(
  text: string,
  oldId: string,
  newId: string,
  allIds: Iterable<string>,
): { text: string; rewrites: number } {
  const occurrences = findWikilinks(text);
  if (occurrences.length === 0) return { text, rewrites: 0 };
  const ids = Array.from(allIds);
  // The id-resolution context must include `oldId` so legacy bare-filename
  // links targeting it still resolve. Replace `newId` with `oldId` so
  // resolution sees the pre-rename universe.
  const ctx = [...ids];
  if (!ctx.includes(oldId)) {
    const renamedPosition = ctx.indexOf(newId);
    if (renamedPosition >= 0) ctx[renamedPosition] = oldId;
    else ctx.push(oldId);
  }
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

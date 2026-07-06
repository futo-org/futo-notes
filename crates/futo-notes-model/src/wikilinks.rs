//! Wikilink parsing: `[[target]]` and `[[target|alias]]`. Returns the link
//! TARGETS (the part before any `|`), trimmed, deduped, in first-seen order.
//! Targets are note ids/titles the UI resolves against the note index.
//!
//! Also hosts the bit-for-bit ports of the TS wikilink RULES
//! (`src/lib/wikilinks.ts`): occurrence scanning, resolution, shortest-unique
//! display suffix, and the rewrite-on-rename machinery. NOTE these are ports
//! of the TS regex semantics, which differ from [`extract_wikilinks`] above
//! in two pinned ways: the TS `WIKILINK_RE` captures the WHOLE inner text
//! (a `|alias` stays part of the target, untrimmed) and it tolerates a `[[`
//! inside the inner text. The port follows TS verbatim; the conformance
//! fixture `tests/conformance/wikilinks.json` locks both sides together.

use std::path::Path;

/// Extract wikilink targets from `content`. An empty target (`[[]]` or
/// `[[ |x]]`) is skipped. Matches the resolution the TS `wikilinks.ts` uses
/// (target = text before the first `|`, trimmed).
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut i = 0usize;
    let n = bytes.len();
    while i + 1 < n {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Find the closing ]]
            if let Some(close) = find_close(content, i + 2) {
                let inner = &content[i + 2..close];
                let target = inner.split('|').next().unwrap_or("").trim();
                if !target.is_empty() && seen.insert(target.to_string()) {
                    out.push(target.to_string());
                }
                i = close + 2;
                continue;
            }
        }
        // Advance by one full char to stay on UTF-8 boundaries.
        i += char_len(bytes[i]);
    }
    out
}

/// Byte index of the `]]` closing a wikilink opened at `from`, or `None`.
/// A `]]` cannot be preceded by another `[[` opening (no nesting).
fn find_close(content: &str, from: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut j = from;
    while j + 1 < bytes.len() {
        if bytes[j] == b']' && bytes[j + 1] == b']' {
            return Some(j);
        }
        // A new `[[` before a close means the first was unterminated.
        if bytes[j] == b'[' && bytes[j + 1] == b'[' {
            return None;
        }
        j += char_len(bytes[j]);
    }
    None
}

/// UTF-8 lead-byte → encoded length.
fn char_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

// ── TS wikilink-rule ports (src/lib/wikilinks.ts, bit-for-bit) ───────────

/// One `[[...]]` occurrence found by [`find_wikilinks`]. Offsets are BYTE
/// offsets into the scanned text (TS carries UTF-16 offsets; the rewrite
/// output built from them is representation-independent, which is what the
/// conformance fixture compares).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikilinkOccurrence {
    /// Start offset of the `[[`.
    pub start: usize,
    /// End offset (exclusive) past the `]]`.
    pub end: usize,
    /// The literal title text between `[[` and `]]`.
    pub target: String,
}

/// Find all `[[...]]` occurrences in `text`. Port of the TS `WIKILINK_RE`
/// (`/\[\[((?:(?!\]\])[^\n])+)\]\]/g`): the inner text is one-or-more chars,
/// each of which is not a newline and does not start a `]]`.
///
/// The regex's greedy `+` can never usefully backtrack (every shorter inner
/// ends at a position the lookahead already proved is not `]]`), so the scan
/// below is deterministic: consume to the first `\n` / `]]` / EOF; match iff
/// stopped at `]]` with a non-empty inner; otherwise retry one position
/// later, exactly like `exec` does. All delimiters are ASCII, so the
/// byte-wise walk can't false-match inside a multi-byte UTF-8 char.
pub fn find_wikilinks(text: &str) -> Vec<WikilinkOccurrence> {
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < n {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Greedily consume `(?:(?!\]\])[^\n])` chars.
            let mut j = i + 2;
            while j < n
                && bytes[j] != b'\n'
                && !(bytes[j] == b']' && j + 1 < n && bytes[j + 1] == b']')
            {
                j += 1;
            }
            // Match iff the inner is non-empty and we stopped at a `]]`.
            if j > i + 2 && j + 1 < n && bytes[j] == b']' && bytes[j + 1] == b']' {
                out.push(WikilinkOccurrence {
                    start: i,
                    end: j + 2,
                    target: text[i + 2..j].to_string(),
                });
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Return the leaf (last component) of a note ID. Mirrors `noteIdLeaf`.
pub fn note_id_leaf(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

/// Compute the shortest path-suffix of `target_id` that does not collide
/// with any other ID in `all_ids`. Returns `target_id` itself if no shorter
/// suffix is unique (e.g. when two IDs are identical, which shouldn't
/// happen but we don't want an infinite loop). Mirrors
/// `shortestUniqueSuffix`: a "suffix" is a tail-aligned slice of components —
/// for ID `A/B/C`, candidates in order are `C`, `B/C`, `A/B/C`.
pub fn shortest_unique_suffix(target_id: &str, all_ids: &[String]) -> String {
    let target: Vec<&str> = target_id.split('/').collect();
    // Pre-compute every other ID's components once.
    let others: Vec<Vec<&str>> = all_ids
        .iter()
        .filter(|id| id.as_str() != target_id)
        .map(|id| id.split('/').collect())
        .collect();
    for i in (0..target.len()).rev() {
        let suffix_len = target.len() - i;
        let candidate = &target[i..];
        let collides = others.iter().any(|other| {
            other.len() >= suffix_len && other[other.len() - suffix_len..] == *candidate
        });
        if !collides {
            return candidate.join("/");
        }
    }
    target_id.to_string()
}

/// Resolve a wikilink target string to a note ID. Mirrors `resolveWikilink`:
///
/// - If `target` is a full path that exactly matches an ID, return that ID.
/// - If `target` is a bare filename and exactly one ID has that leaf,
///   return that ID (legacy behavior).
/// - A multi-component target that didn't match exactly resolves iff it is
///   the path-suffix of exactly one ID.
/// - Otherwise `None` (broken link — never silently pick a winner).
pub fn resolve_wikilink(target: &str, all_ids: &[String]) -> Option<String> {
    if target.is_empty() {
        return None;
    }
    // Exact ID match — covers full paths and root-level bare filenames.
    if all_ids.iter().any(|id| id == target) {
        return Some(target.to_string());
    }
    // Bare filename: target has no `/`. Find candidates whose leaf matches.
    if !target.contains('/') {
        let mut candidates = all_ids.iter().filter(|id| note_id_leaf(id) == target);
        let first = candidates.next()?;
        if candidates.next().is_none() {
            return Some(first.clone());
        }
        return None; // ambiguous — broken
    }
    // Multi-component target that didn't match exactly. Try as a unique
    // path-suffix: if exactly one ID ends in the same components, accept.
    let target_parts: Vec<&str> = target.split('/').collect();
    let mut found: Option<&String> = None;
    let mut count = 0usize;
    for id in all_ids {
        let id_parts: Vec<&str> = id.split('/').collect();
        if id_parts.len() < target_parts.len() {
            continue;
        }
        if id_parts[id_parts.len() - target_parts.len()..] == *target_parts.as_slice() {
            found = Some(id);
            count += 1;
        }
    }
    if count == 1 {
        return found.cloned();
    }
    None
}

/// Rewrite every wikilink in `text` whose target resolves to `old_id` (per
/// the resolution rules) so the on-disk text uses `new_id`. Returns the
/// rewritten text and the count of rewrites. Mirrors `rewriteWikilinks`,
/// including its text-level scope: links inside code fences/inline code are
/// rewritten too (the TS makes no markdown-context exception).
pub fn rewrite_wikilinks(
    text: &str,
    old_id: &str,
    new_id: &str,
    all_ids: &[String],
) -> (String, u32) {
    let occurrences = find_wikilinks(text);
    if occurrences.is_empty() {
        return (text.to_string(), 0);
    }
    // The id-resolution context must include `old_id` so legacy bare-filename
    // links targeting it still resolve. Replace `old_id` in the universe with
    // itself so resolution works against pre-rename state.
    let ctx: Vec<String> = if all_ids.iter().any(|id| id == old_id) {
        all_ids.to_vec()
    } else {
        let mut ids = all_ids.to_vec();
        ids.push(old_id.to_string());
        ids
    };
    let mut rewrites = 0u32;
    let mut cursor = 0usize;
    let mut out = String::with_capacity(text.len());
    for occ in &occurrences {
        let resolved = resolve_wikilink(&occ.target, &ctx);
        out.push_str(&text[cursor..occ.start]);
        if resolved.as_deref() == Some(old_id) {
            out.push_str("[[");
            out.push_str(new_id);
            out.push_str("]]");
            rewrites += 1;
        } else {
            out.push_str(&text[occ.start..occ.end]);
        }
        cursor = occ.end;
    }
    out.push_str(&text[cursor..]);
    (out, rewrites)
}

/// Rewrite every wikilink in every note in the vault that targets `old_id`
/// to point at `new_id` — the Rust-owned equivalent of the desktop
/// `rewriteWikilinksForRename` (notes.svelte.ts). This includes the renamed
/// note's OWN body: self-referencing links follow the rename too (spec:
/// editor.md). Touches only notes whose body actually contains a `[[` and
/// only writes back when the rewrite changed the text. A failed write skips
/// that note and continues (the TS warns and moves on too), so the pass
/// never leaves the rest of the vault un-relinked. Returns the count of
/// notes rewritten.
pub fn relink_note_references(
    notes_root: &Path,
    old_id: &str,
    new_id: &str,
) -> Result<u32, String> {
    if old_id == new_id {
        return Ok(0);
    }
    let notes = crate::crud::scan_notes(notes_root);
    let all_ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();
    let mut rewritten = 0u32;
    for note in &notes {
        // The renamed note itself is NOT skipped: self-referencing links in
        // its own body follow the rename too (spec: editor.md). At relink
        // time the scan sees the note at whichever id currently exists on
        // disk (post-rename callers see `new_id`), so reading/writing
        // `note.id` always hits the file that exists.
        let body = crate::crud::read_note(notes_root, &note.id);
        // Cheap pre-filter: no `[[` means no wikilinks, skip the rewrite.
        if !body.contains("[[") {
            continue;
        }
        let (text, rewrites) = rewrite_wikilinks(&body, old_id, new_id, &all_ids);
        if rewrites == 0 || text == body {
            continue;
        }
        match crate::crud::write_note(notes_root, &note.id, &text) {
            Ok(()) => rewritten += 1,
            Err(e) => eprintln!("[wikilink-rewrite] failed to update {}: {e}", note.id),
        }
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ── find_wikilinks: pin the TS WIKILINK_RE semantics ─────────────────

    #[test]
    fn find_basic_and_offsets() {
        let occ = find_wikilinks("a [[note]] b");
        assert_eq!(occ.len(), 1);
        assert_eq!((occ[0].start, occ[0].end, occ[0].target.as_str()), (2, 10, "note"));
    }

    #[test]
    fn find_keeps_pipe_alias_in_target() {
        // The TS regex captures the WHOLE inner text — `|alias` included.
        let occ = find_wikilinks("[[Specs/x|the spec]]");
        assert_eq!(occ[0].target, "Specs/x|the spec");
    }

    #[test]
    fn find_rejects_newline_and_empty() {
        assert!(find_wikilinks("[[a\nb]]").is_empty());
        assert!(find_wikilinks("[[]]").is_empty());
    }

    #[test]
    fn find_stops_at_first_close_and_tolerates_inner_open() {
        // `[[a]]]` → target `a`, trailing `]` left alone.
        let occ = find_wikilinks("[[a]]]");
        assert_eq!((occ[0].target.as_str(), occ[0].end), ("a", 5));
        // The TS regex happily swallows a nested `[[` (unlike extract_wikilinks).
        let occ = find_wikilinks("[[a[[b]]");
        assert_eq!(occ[0].target, "a[[b");
    }

    #[test]
    fn find_recovers_after_failed_match() {
        // The unterminated `[[a\n` fails; the scan resumes and finds `[[b]]`.
        let occ = find_wikilinks("[[a\n[[b]]");
        assert_eq!(occ.len(), 1);
        assert_eq!(occ[0].target, "b");
    }

    #[test]
    fn find_handles_unicode_targets() {
        let occ = find_wikilinks("voir [[café résumé]] et [[🎉 party]]");
        let targets: Vec<&str> = occ.iter().map(|o| o.target.as_str()).collect();
        assert_eq!(targets, vec!["café résumé", "🎉 party"]);
    }

    // ── resolve_wikilink ─────────────────────────────────────────────────

    #[test]
    fn resolve_exact_bare_and_ambiguous() {
        let universe = ids(&["notes", "Projects/notes", "Specs/x", "Drafts/x"]);
        // Exact id wins even when the leaf is ambiguous.
        assert_eq!(resolve_wikilink("notes", &universe).as_deref(), Some("notes"));
        // Ambiguous bare leaf is broken, never a silent winner.
        assert_eq!(resolve_wikilink("x", &universe), None);
        assert_eq!(resolve_wikilink("", &universe), None);
        assert_eq!(resolve_wikilink("missing", &universe), None);
    }

    #[test]
    fn resolve_unique_path_suffix() {
        let universe = ids(&["Recipes/pasta", "Recipes/Dinner/pasta"]);
        assert_eq!(
            resolve_wikilink("Dinner/pasta", &universe).as_deref(),
            Some("Recipes/Dinner/pasta")
        );
        // Two ids end in `pasta` → the bare leaf stays broken.
        assert_eq!(resolve_wikilink("pasta", &universe), None);
    }

    // ── shortest_unique_suffix ───────────────────────────────────────────

    #[test]
    fn suffix_grows_until_unique() {
        let universe = ids(&["Specs/folder-support", "Specs/Drafts/folder-support", "other"]);
        assert_eq!(
            shortest_unique_suffix("Specs/Drafts/folder-support", &universe),
            "Drafts/folder-support"
        );
        assert_eq!(shortest_unique_suffix("other", &universe), "other");
    }

    #[test]
    fn suffix_falls_back_to_full_id_on_total_collision() {
        // A longer id ending in the FULL target collides at every suffix
        // length → return target_id itself (the no-infinite-loop fallback).
        let universe = ids(&["a/x", "b/a/x"]);
        assert_eq!(shortest_unique_suffix("a/x", &universe), "a/x");
        // Duplicate ids are excluded from the collision set entirely (the TS
        // `if (id === targetId) continue` skips BOTH copies), so the leaf wins.
        let universe = ids(&["dup/x", "dup/x"]);
        assert_eq!(shortest_unique_suffix("dup/x", &universe), "x");
    }

    // ── rewrite_wikilinks ────────────────────────────────────────────────

    #[test]
    fn rewrite_full_path_and_legacy_bare() {
        // Post-rename universe (old id already replaced) — the ctx re-adds it.
        let universe = ids(&["Lists/grocery list", "other"]);
        let (text, n) = rewrite_wikilinks(
            "see [[grocery list]] and [[grocery list]]",
            "grocery list",
            "Lists/grocery list",
            &universe,
        );
        assert_eq!(text, "see [[Lists/grocery list]] and [[Lists/grocery list]]");
        assert_eq!(n, 2);
    }

    #[test]
    fn rewrite_leaves_alias_and_ambiguous_links_alone() {
        let universe = ids(&["Specs/x", "Drafts/x", "Specs/y"]);
        // `|alias` is part of the target per the TS regex → unresolvable → kept.
        let (text, n) = rewrite_wikilinks("[[Specs/y|spec]]", "Specs/y", "Specs/z", &universe);
        assert_eq!((text.as_str(), n), ("[[Specs/y|spec]]", 0));
        // Ambiguous bare leaf doesn't resolve to old_id → kept.
        let (text, n) = rewrite_wikilinks("[[x]]", "Specs/x", "Specs/x2", &universe);
        assert_eq!((text.as_str(), n), ("[[x]]", 0));
    }

    #[test]
    fn rewrite_is_text_level_like_ts() {
        // The TS rewrite has no code-fence exception; neither does the port.
        let universe = ids(&["a", "b"]);
        let (text, n) = rewrite_wikilinks("```\n[[a]]\n```", "a", "a2", &universe);
        assert_eq!((text.as_str(), n), ("```\n[[a2]]\n```", 1));
    }
}

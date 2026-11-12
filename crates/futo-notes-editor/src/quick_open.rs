//! Quick open: the first screens of a long note, parsed from its leading
//! bytes alone, for a host to show read-only while the whole note opens.
//!
//! The prefix ends where its parse is exactly the whole note's, so the
//! handover to the full session changes nothing on screen. Block parsing
//! reads forward: what a line is depends on the lines before it and, for a
//! setext underline or a table delimiter, the one after. A cut therefore
//! stands at the start of a column-0 top-level block that follows an empty
//! line, with that block's own line inside the bytes read: every block
//! before it was closed by that empty line on the same lines the whole note
//! has. Two things reach backwards and are checked apart from the scan:
//! front matter, which must close inside the bytes read, and link reference
//! and footnote definitions, which resolve document-wide — a shown `[` with a
//! `]:` anywhere after the cut declines. A lone CR ends the scan, as it does
//! the desktop's chunk planner (docs/spec/editor/performance.md).
use pulldown_cmark::{Event, Parser};

use crate::{
    DisplayOffset, DisplayRange, EditorSession, ProjectionSlice, Revision, TableDescription,
};

/// How many leading bytes of a note a host reads for its first screens.
pub const QUICK_OPEN_BYTES: usize = 16 * 1024;

/// The first screens of a note exactly as its whole-note session shows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickOpen {
    /// The leading source bytes shown.
    pub source_len: usize,
    pub display: String,
    /// Styles for all of `display` as a revision-0 session projects them,
    /// through [`shown_projection`].
    pub projection: ProjectionSlice,
    /// The tables starting in `display`.
    pub tables: Vec<TableDescription>,
}

/// Where `head`'s first screens end, ignoring definitions after them;
/// `None` when no cut stands.
pub fn quick_open_cut(head: &str) -> Option<usize> {
    let boundaries = boundaries(head);
    let last = boundaries.len().checked_sub(2)?;
    Some(boundaries[last])
}

/// Every place `head` may be cut, ascending. A boundary is a top-level block
/// starting at column 0 after an empty line, on a line wholly inside `head`.
fn boundaries(head: &str) -> Vec<usize> {
    if head.starts_with('\u{feff}') {
        return Vec::new();
    }
    let mut region = &head[..head.rfind('\n').map_or(0, |at| at + 1)];
    if let Some(cr) = lone_cr(region) {
        region = &region[..region[..cr].rfind('\n').map_or(0, |at| at + 1)];
    }
    let metadata = crate::inline::front_matter::len(region.bytes());
    if metadata == 0 && crate::inline::front_matter::opener_end(region.bytes()).is_some() {
        // Unclosed in what was read; the whole note may still close it.
        return Vec::new();
    }
    let bytes = region.as_bytes();
    let mut depth = 0usize;
    let mut found = Vec::new();
    let parser = Parser::new_ext(&region[metadata..], crate::inline::parser_options());
    for (event, range) in parser.into_offset_iter() {
        let top = depth == 0;
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
        let at = metadata + range.start;
        if top
            && at > metadata
            && !matches!(bytes.get(at), Some(b' ' | b'\t') | None)
            && (region[..at].ends_with("\n\n") || region[..at].ends_with("\n\r\n"))
        {
            found.push(at);
        }
    }
    found
}

fn lone_cr(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    (0..bytes.len()).find(|&at| bytes[at] == b'\r' && bytes.get(at + 1) != Some(&b'\n'))
}

/// Whether `bytes` may hold a link reference or footnote definition.
pub fn may_define_reference(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|pair| pair == b"]:")
}

/// The first screens of a note from its leading bytes `head`.
/// `rest_may_define` answers [`may_define_reference`] for the note's bytes
/// after `head`, starting from `head`'s last byte; `note_ids` are the vault's,
/// as the whole note's session receives them. Each runs only when needed.
pub fn quick_open(
    head: &str,
    rest_may_define: impl FnOnce() -> bool,
    note_ids: impl FnOnce() -> Vec<String>,
) -> Option<QuickOpen> {
    // The rebuilt core has no quick open yet: a note opens whole.
    if cfg!(feature = "engine") {
        return None;
    }
    let boundaries = boundaries(head);
    let mut rest_may_define = Some(rest_may_define);
    let mut note_ids = Some(note_ids);
    let mut ids = None;
    // Show up to one boundary and parse to the next: the block after the cut
    // is parsed though never shown, so the shown rows are followed by the same
    // block they are in the whole note. Should the engine's rows cross the
    // cut, an earlier one is tried.
    for pair in boundaries.windows(2).rev().take(4) {
        let (end, parsed) = (pair[0], pair[1]);
        let shown = &head[..end];
        if shown.contains('[') {
            if may_define_reference(&head.as_bytes()[end..]) {
                return None;
            }
            if rest_may_define.take().is_some_and(|rest| rest()) {
                return None;
            }
        }
        let mut session = EditorSession::open(&head[..parsed]);
        if shown.contains("[[") {
            let ids = ids.get_or_insert_with(|| note_ids.take().map_or_else(Vec::new, |f| f()));
            session.update_note_ids(ids);
        }
        let Some(display_end) = row_boundary(&session, end) else {
            continue;
        };
        let range = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(display_end),
        };
        let revision = session.revision();
        debug_assert_eq!(revision, Revision(0));
        let projection = shown_projection(session.project(revision, range).ok()?);
        // A table row holds a pipe; the search costs as much as the parse.
        let tables = if shown.contains('|') {
            session.inspect_tables(revision, range).ok()?
        } else {
            Vec::new()
        };
        return Some(QuickOpen {
            source_len: end,
            display: projection.text.clone(),
            projection,
            tables,
        });
    }
    None
}

/// The display offset of `source` when it ends one of `session`'s rows.
fn row_boundary(session: &EditorSession, source: usize) -> Option<usize> {
    let (row, start, display, _) = session.projection.rows.source_row_with_work(source);
    if start == source {
        Some(display)
    } else if start + row.source_len == source {
        Some(display + row.display.len())
    } else {
        None
    }
}

/// What a renderer draws of `slice` within its range: anything starting at or
/// after the range's end belongs to the block after it, which is not shown.
/// Correspondence maps coordinates for edits, so it is not carried.
pub fn shown_projection(mut slice: ProjectionSlice) -> ProjectionSlice {
    let end = slice.range.end.0;
    slice.correspondence.clear();
    slice.runs.retain(|run| run.range.start.0 < end);
    slice.blocks.retain(|block| block.range.start.0 < end);
    slice.links.retain(|link| link.range.start.0 < end);
    slice.wikilinks.retain(|link| link.range.start.0 < end);
    slice.atoms.retain(|atom| atom.range.start.0 < end);
    slice
}

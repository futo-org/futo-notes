//! Quick open: the first screens of a long note, read from its leading bytes
//! alone, for a host to show read-only while the whole note opens.
//!
//! On the core, a line's reading depends only on the lines above it, plus
//! one look-back: a delimiter row makes the line above it a table header.
//! A line's display looks one line ahead (an opening fence followed by its
//! closing fence shows as one empty line). So the head reads every whole line
//! of the bytes read and shows all of them but the last: each shown line then
//! reads and shows exactly as in the whole note. Two things move the cut:
//!
//! - Line 1 `---` opens front matter only if a later line is `---`. When no
//!   such line is in the head, the rest of the note decides, so the note
//!   opens whole.
//! - A table is described whole (its rows and extent), so the shown lines
//!   never end inside one: a table at the cut is left for the whole open.
//!
//! Without the `engine` feature the CommonMark engine's quick open
//! (`commonmark.rs`) runs instead; the cut-over deletes it.
#[cfg(not(feature = "engine"))]
mod commonmark;

use crate::engine::Engine;
use crate::lines::Kind;
use crate::{ProjectionSlice, TableDescription};

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

/// Whether `bytes` may hold a link reference or footnote definition, for the
/// CommonMark path's `rest_may_define`; the core reads no such definitions.
pub fn may_define_reference(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|pair| pair == b"]:")
}

/// The first screens of a note from its leading bytes `head`.
/// `rest_may_define` answers [`may_define_reference`] for the note's bytes
/// after `head`, starting from `head`'s last byte; `note_ids` are the vault's,
/// as the whole note's session receives them. Each runs only when needed.
/// On the core, which reads no reference definitions, `rest_may_define` is
/// never called. `None` when no cut stands.
pub fn quick_open(
    head: &str,
    rest_may_define: impl FnOnce() -> bool,
    note_ids: impl FnOnce() -> Vec<String>,
) -> Option<QuickOpen> {
    #[cfg(feature = "engine")]
    {
        let _ = rest_may_define;
        open_head(head, note_ids)
    }
    #[cfg(not(feature = "engine"))]
    commonmark::quick_open(head, rest_may_define, note_ids)
}

/// Where the first screens of `head`, the leading bytes of a longer note,
/// end; `None` when no cut stands.
pub fn quick_open_cut(head: &str) -> Option<usize> {
    #[cfg(feature = "engine")]
    return shown_len(&Engine::open(&head[..parsed_len(head)?]));
    #[cfg(not(feature = "engine"))]
    commonmark::quick_open_cut(head)
}

/// The head's whole lines: through its last `\n`, so a cut never splits a
/// CRLF or a character.
#[cfg_attr(not(feature = "engine"), allow(dead_code))]
pub(crate) fn parsed_len(head: &str) -> Option<usize> {
    head.rfind('\n').map(|at| at + 1)
}

/// Where the shown lines end in the source of `engine`, opened on a head's
/// whole lines; `None` when no line can be shown.
#[cfg_attr(not(feature = "engine"), allow(dead_code))]
pub(crate) fn shown_len(engine: &Engine) -> Option<usize> {
    // The head's text ends in `\n`, so its last line is the empty one after
    // it. The line before that is read but not shown: a delimiter row there
    // makes the line above it a header, a closing fence makes an opening
    // fence above it an empty line.
    let mut shown = engine.line_count().checked_sub(2)?;
    let first = engine.line(0);
    if without_ending(&first.text) == "---" && !matches!(first.line.kind, Kind::FrontMatter(_)) {
        return None;
    }
    while shown > 0 && matches!(engine.line(shown - 1).line.kind, Kind::Table { .. }) {
        shown -= 1;
    }
    (shown > 0).then(|| engine.line_start(shown))
}

/// A line without its `\n` or `\r\n` (a lone CR is an ordinary character).
fn without_ending(line: &str) -> &str {
    match line.strip_suffix('\n') {
        Some(line) => line.strip_suffix('\r').unwrap_or(line),
        None => line,
    }
}

#[cfg(feature = "engine")]
fn open_head(head: &str, note_ids: impl FnOnce() -> Vec<String>) -> Option<QuickOpen> {
    use crate::{DisplayOffset, DisplayRange, EditorSession};
    let mut session = EditorSession::open(&head[..parsed_len(head)?]);
    let engine = session.next.as_deref()?;
    let source_len = shown_len(engine)?;
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(engine.display_of(source_len)),
    };
    let shown = &head[..source_len];
    if shown.contains("[[") {
        session.update_note_ids(&note_ids());
    }
    let revision = session.revision();
    let projection = shown_projection(session.project(revision, range).ok()?);
    // A table row holds a pipe; the search costs as much as the read.
    let mut tables = if shown.contains('|') {
        session.inspect_tables(revision, range).ok()?
    } else {
        Vec::new()
    };
    tables.retain(|table| table.display.start.0 < range.end.0);
    Some(QuickOpen {
        source_len,
        display: projection.text.clone(),
        projection,
        tables,
    })
}

/// What a renderer draws of `slice` within its range: anything starting at or
/// after the range's end belongs to the line after it, which is not shown.
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

//! The mobile toolbar's format toggle at a collapsed caret: the word the
//! caret is inside or at the start of, and where the caret lands after the
//! word is formatted.
use super::super::super::line::Entry;
use super::super::super::{read, store, Engine};
use super::draft::{glyphs, inline_line, regions};
use super::{carried_with, Accept};
use crate::{DisplayOffset, DisplayRange, EditorError, InlineFormat, Revision, ViewChange};
use unicode_segmentation::UnicodeSegmentation;

impl Engine {
    /// The word a collapsed caret is inside or at the start of, as a display
    /// range: a Unicode word (letters, digits, `can't`, `snake_case`) of one
    /// line's inline text, or of one table cell's. `None` at a word's end,
    /// between spaces or punctuation, and on lines without inline text.
    fn caret_word(&self) -> Option<DisplayRange> {
        let at = self.selection.start.0;
        if at != self.selection.end.0 {
            return None;
        }
        let (index, before) = self.line_at_display(store::display, at);
        let entry = self.store.get(index);
        if !inline_line(entry) {
            return None;
        }
        let glyphs = glyphs(entry);
        let caret = glyphs
            .iter()
            .position(|glyph| before.display + glyph.display == at)?;
        let region = regions(entry)
            .into_iter()
            .find(|region| region.contains(&glyphs[caret].src))?;
        let run: Vec<usize> = (0..glyphs.len())
            .filter(|&i| region.contains(&glyphs[i].src))
            .collect();
        let text: String = run.iter().map(|&i| glyphs[i].ch).collect();
        let mut offset = 0;
        let starts: Vec<usize> = text
            .chars()
            .map(|ch| {
                let start = offset;
                offset += ch.len_utf8();
                start
            })
            .collect();
        let caret_byte = starts[run.iter().position(|&i| i == caret)?];
        let (start, word) = text
            .split_word_bound_indices()
            .find(|(start, word)| *start <= caret_byte && caret_byte < start + word.len())?;
        // Emoji break a word (`1️⃣hello` segments as one): keep the caret's
        // stretch of the segment between them.
        let clusters: Vec<(usize, &str)> = word
            .grapheme_indices(true)
            .map(|(at, cluster)| (start + at, cluster))
            .collect();
        let here = clusters
            .iter()
            .position(|(at, cluster)| *at <= caret_byte && caret_byte < at + cluster.len())?;
        if emoji(clusters[here].1) {
            return None;
        }
        let mut lo = here;
        while lo > 0 && !emoji(clusters[lo - 1].1) {
            lo -= 1;
        }
        let mut hi = here + 1;
        while hi < clusters.len() && !emoji(clusters[hi].1) {
            hi += 1;
        }
        if !clusters[lo..hi]
            .iter()
            .any(|(_, cluster)| cluster.chars().any(char::is_alphanumeric))
        {
            return None;
        }
        let (start, end) = (
            clusters[lo].0,
            clusters[hi - 1].0 + clusters[hi - 1].1.len(),
        );
        let first = run[starts.iter().position(|&byte| byte == start)?];
        let last = run[starts.iter().rposition(|&byte| byte < end)?];
        let end = glyphs[last].display + glyphs[last].ch.len_utf8();
        Some(DisplayRange {
            start: DisplayOffset(before.display + glyphs[first].display),
            end: DisplayOffset(before.display + end),
        })
    }

    /// The mobile toolbar's format toggle. A collapsed caret inside a word
    /// or at its start toggles the format over the whole word, as a
    /// selection of it would, and stays where it was; at a word's end, or
    /// away from any word, it changes the formats typing there carries. A
    /// selection toggles as `toggle_format_view` does.
    pub(crate) fn toggle_toolbar_format_view(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.selection.start != self.selection.end {
            return self.toggle_format_view(expected, format, accept);
        }
        let mut work = 0;
        let mut word = false;
        // Marked text commits first, then the word is read where the caret is.
        let change = self.run(
            expected,
            |engine| {
                let Some(range) = engine.caret_word() else {
                    return Ok(None);
                };
                word = true;
                // The caret keeps its formats with the toggled one changed,
                // and its place inside or outside links: it lands among the
                // word's hidden marks where it reads both (so Redo lands
                // there too), else it carries the formats.
                let formats = carried_with(
                    engine.active_formats(),
                    format,
                    !engine.range_formats(range).contains(&format),
                );
                let caret = engine.caret_source();
                let (index, before) = read::line_at(&engine.store, caret);
                let links = Landing::at(engine.store.get(index), caret - before.source).links;
                let want = Landing { formats, links };
                let command = engine.format_command(
                    range,
                    engine.selection,
                    Some(&want),
                    format,
                    &mut work,
                )?;
                Ok(command.map(|mut command| {
                    command.carry = Some(want.formats);
                    command
                }))
            },
            accept,
        )?;
        if !word {
            self.toggle_carried(format);
        }
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += work;
            view
        }))
    }
}

/// Whether a grapheme cluster is an emoji: one in the emoji blocks, or one
/// drawn as an emoji by a variation selector or keycap (`1️⃣`, `❤️`).
fn emoji(cluster: &str) -> bool {
    cluster
        .chars()
        .any(|ch| matches!(ch, '\u{1F000}'..='\u{1FAFF}' | '\u{20E3}' | '\u{FE0F}'))
}

/// What a caret at a source offset reads: the formats of the spans whose
/// text holds it, as `Engine::formats_at` reads them, and the other spans
/// (links) holding it, each named by how many visible characters precede
/// its text, which formatting never changes.
#[derive(PartialEq, Eq)]
pub(super) struct Landing {
    pub formats: Vec<InlineFormat>,
    pub links: Vec<usize>,
}

impl Landing {
    pub fn at(entry: &Entry, at: usize) -> Self {
        let mut formats = Vec::new();
        let mut links = Vec::new();
        for span in &entry.spans {
            if span.open.end <= at && at <= span.close.start {
                match super::super::super::project::format_of(&span.kind) {
                    Some(format) => formats.push(format),
                    None => links.push(span.open.end),
                }
            }
        }
        if !links.is_empty() {
            let glyphs = glyphs(entry);
            for link in &mut links {
                *link = glyphs.iter().filter(|glyph| glyph.src < *link).count();
            }
            links.sort();
        }
        formats.sort();
        formats.dedup();
        Self { formats, links }
    }
}

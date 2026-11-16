//! Planning a replacement: which source bytes typing over a display
//! range writes, and where the caret lands.
use super::super::code_block::{fence_indent, is_opening_fence};
use super::super::line::Role;
use super::super::{read, store, Engine};
use super::runs::changed_stretch;
use super::spans::Kept;
use crate::lines::{block, Kind};
use crate::{DisplayOffset, DisplayRange, InlineFormat, InputAction};
use std::ops::Range;

/// A planned text edit and where the caret ends up after it.
pub(crate) struct Plan {
    pub range: Range<usize>,
    pub inserted: String,
    /// Source offset of the caret after the edit.
    pub caret: usize,
    /// Bytes of source read to plan it, beyond the edit's own re-read.
    pub parsed: usize,
    /// Formats the caret carries after the edit, when the edit sets them.
    pub carry: Option<Vec<InlineFormat>>,
}

impl Engine {
    // ---- Planning ----

    /// The line ending typing on an empty line with no text behind it
    /// writes: the line's own, else the one above it, else LF.
    pub(crate) fn empty_line_ending(&self, index: usize) -> String {
        let own = self.store.get(index).ending();
        if !own.is_empty() {
            return own.to_owned();
        }
        if index > 0 {
            let above = self.store.get(index - 1).ending();
            if !above.is_empty() {
                return above.to_owned();
            }
        }
        "\n".to_owned()
    }

    /// What typing on line `index`, an empty line with no text behind it,
    /// writes before the text: the line ending, then on an empty code block
    /// the opening fence's indent, which its first code line starts with.
    pub(crate) fn empty_line_start(&self, index: usize) -> String {
        let entry = self.store.get(index);
        let indent = if is_opening_fence(entry) {
            fence_indent(entry)
        } else {
            ""
        };
        format!("{}{indent}", self.empty_line_ending(index))
    }

    /// Whether display offset `at` is on a line that shows with no text
    /// behind it, and that line's index.
    pub(crate) fn empty_line(&self, at: usize) -> Option<usize> {
        if self.pin.is_some() && self.selection.start.0 == at {
            return None;
        }
        let (index, before) = self.line_at_display(store::display, at);
        (self.store.get(index).view.role == Role::Empty && at == before.display).then_some(index)
    }

    /// Typing at a divider's edge (display rule 5 in `line.rs`): a divider
    /// line shows only its rule, so the text goes on a line of its own beside
    /// it, inside the divider's quotes. What to write at source `at`, and the
    /// caret's offset into it; `None` when `at` is not at a divider's edge
    /// or the text brings its own line break there.
    pub(crate) fn beside_divider(&self, at: usize, text: &str) -> Option<(String, usize)> {
        if text.is_empty() {
            return None;
        }
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        if entry.line.kind != Kind::Divider {
            return None;
        }
        let body = entry.body();
        let quotes = &body[..body.find(['-', '*', '_']).unwrap_or(0)];
        let ending = self.empty_line_ending(index);
        let local = at - before.source;
        if local == 0 && !text.ends_with('\n') {
            Some((format!("{quotes}{text}{ending}"), quotes.len() + text.len()))
        } else if local == entry.body_len() && !text.starts_with(['\n', '\r']) {
            let written = format!("{ending}{quotes}{text}");
            let caret = written.len();
            Some((written, caret))
        } else {
            None
        }
    }

    /// Typing on an empty quote line whose last `>` has no space after it
    /// (display rule 6 in `line.rs`): the line shows as an empty quoted line,
    /// so text that as typed would leave it fewer quote levels (`>x` is a
    /// plain line) gets the space the quote needs first, as Enter in a quote
    /// writes `> `. Whether text typed at source `at` does.
    pub(crate) fn quote_space(&self, at: usize, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        let line = &entry.line;
        if line.kind != Kind::Blank
            || line.quote == 0
            || at - before.source != line.marker.end
            || !entry.body().ends_with('>')
        {
            return false;
        }
        let typed = format!("{}{text}", entry.body());
        block::read_line(&mut entry.carry.clone(), &typed, 0).quote < line.quote
    }

    /// Replace display `range` with `text`. A collapsed caret inserts exactly
    /// `text` where it maps. A selection removes the visible text in it and
    /// the line markers and hidden lines inside it, keeps the syntax of spans
    /// that reach out of it, and drops the syntax of spans left empty; the
    /// text lands where the selection starts, inside spans that start there.
    /// A code block it reaches into or out of goes whole (`block_reach`), and
    /// so does a table it covers every cell of (`whole_tables`).
    /// Every plan, so every input, key and command, first takes `range`'s
    /// ends out of images and wikilinks (`plan_writing`).
    /// Deleting exactly a list item's marker takes it off as Backspace after
    /// it does (`commands/lists/marker.rs`).
    pub(crate) fn plan(&self, range: DisplayRange, text: &str) -> Plan {
        self.plan_writing(range, text, !text.is_empty())
    }

    /// Display `range` removed for a command that then writes its own text
    /// at the caret (the paragraph keys, the divider, a shaped paste): as a
    /// deletion, except that it never takes the line break above an opening
    /// fence (`kept_break`), so the fence's line stays out of what the
    /// command rewrites.
    pub(crate) fn plan_cleared(&self, range: DisplayRange) -> Plan {
        self.plan_writing(range, "", true)
    }

    /// Images and wikilinks are atoms: an end of `range` inside one moves to
    /// its edge (`outside_atoms`), so no plan keeps part of one's spelling.
    /// No plan writes front matter (`in_body`).
    fn plan_writing(&self, range: DisplayRange, text: &str, writes: bool) -> Plan {
        let range = self.whole_tables(self.outside_atoms(self.in_body(range)));
        let removal = text
            .is_empty()
            .then(|| self.selected_marker(range))
            .flatten();
        if let Some(removal) = removal.and_then(|index| self.marker_removal(index)) {
            return Plan {
                range: removal.edit.range,
                inserted: removal.edit.text,
                caret: removal.caret,
                parsed: 0,
                carry: None,
            };
        }
        let plan = self.replacement(range, text, writes);
        // A deletion keeps a span's format when it leaves a space at its
        // edge (inline family, `commands/inline/typing.rs`).
        match self.kept_formats(&plan.range, &plan.inserted) {
            Some(kept) => Plan {
                range: kept.range,
                inserted: kept.inserted,
                caret: kept.caret,
                parsed: kept.parsed,
                carry: None,
            },
            None => plan,
        }
    }

    /// The source offset input at collapsed display `range` lands at. Input
    /// at a caret the host placed elsewhere stands where a fresh selection
    /// of it would: after hidden syntax only at the note's start, otherwise
    /// before it, so text typed where a span ends lands inside it. The
    /// core's own affinity belongs to its own selection, not to this offset.
    pub(crate) fn input_at(&self, range: DisplayRange) -> usize {
        if range == self.selection {
            return self.caret_source();
        }
        let (lo, hi) = self.source_bounds(range.start.0);
        if range.start.0 == 0 {
            hi
        } else {
            lo
        }
    }

    /// Typing `inserted` at a collapsed `range`: exactly that, where the
    /// caret maps, unless it is at a divider's edge or on an empty quote
    /// line that needs its space.
    fn at_caret(&self, range: DisplayRange, mut inserted: String) -> Plan {
        let at = self.input_at(range);
        if self.quote_space(at, &inserted) {
            inserted.insert(0, ' ');
        }
        if let Some((written, caret)) = self.beside_divider(at, &inserted) {
            return Plan {
                range: at..at,
                caret: at + caret,
                inserted: written,
                parsed: 0,
                carry: None,
            };
        }
        Plan {
            range: at..at,
            caret: at + inserted.len(),
            inserted,
            parsed: 0,
            carry: None,
        }
    }

    fn replacement(&self, range: DisplayRange, text: &str, writes: bool) -> Plan {
        let (s, e) = (range.start.0, range.end.0);
        // A code block the range takes whole (`commands/fences/reach.rs`).
        let reach = self.block_reach(range);
        let mut inserted = String::new();
        if reach.is_none() && (s != e || !text.is_empty()) {
            if let Some(index) = self.empty_line(s) {
                inserted.push_str(&self.empty_line_start(index));
            }
        }
        inserted.push_str(text);
        if s == e && reach.is_none() {
            return self.at_caret(range, inserted);
        }
        let (lo_s, _) = self.source_span(s);
        let (_, hi_e) = self.source_span(e);
        let (from, to) = match &reach {
            Some(reach) => (reach.start, self.kept_break(reach.start, reach.end, writes)),
            None => (self.source_bounds(s).1, self.source_bounds(e).0),
        };
        let lo_s = lo_s.min(from);
        let hi_e = hi_e.max(to);
        if self.quote_space(from, &inserted) {
            inserted.insert(0, ' ');
        }

        let (kept, mut removed) = self.span_syntax(lo_s..hi_e, from..to, !text.is_empty());
        if inserted.is_empty() {
            removed.extend(self.seam_joins(from, to));
        }
        let start = removed.iter().map(|r| r.start).fold(from, usize::min);
        let end = removed.iter().map(|r| r.end).fold(to, usize::max);
        let old = self.source_slice(start..end);
        let keep_outside = |zone: Range<usize>| {
            let mut out = String::new();
            let mut at = zone.start;
            let mut cuts: Vec<&Range<usize>> = removed
                .iter()
                .filter(|r| r.start < zone.end && r.end > zone.start)
                .collect();
            cuts.sort_by_key(|r| r.start);
            for cut in cuts {
                out.push_str(&old[at - start..cut.start.max(at) - start]);
                at = at.max(cut.end);
            }
            out.push_str(&old[at - start..zone.end - start]);
            out
        };
        let mut replacement = keep_outside(start..from);
        let caret = start + replacement.len() + inserted.len();
        replacement.push_str(&inserted);
        // Syntax kept inside the selection follows the text. A span closing
        // right where one of the same kind and spelling opens joins it: both
        // marks go (deleting `b c` from `**ab** **cd**` leaves `**ad**`).
        let spelled = |piece: &Kept| &old[piece.range.start - start..piece.range.end - start];
        let mut joined: Vec<&Kept> = Vec::new();
        for piece in &kept {
            let joins = joined.last().is_some_and(|last| {
                piece.opens
                    && !last.opens
                    && last.kind == piece.kind
                    && spelled(last) == spelled(piece)
            });
            if joins {
                joined.pop();
            } else {
                joined.push(piece);
            }
        }
        for piece in joined {
            replacement.push_str(spelled(piece));
        }
        replacement.push_str(&keep_outside(to..end));
        // Trim what the replacement leaves as it was.
        let prefix = old
            .bytes()
            .zip(replacement.bytes())
            .take_while(|(a, b)| a == b)
            .count()
            .min(caret - start - inserted.len());
        let mut prefix = prefix;
        while !old.is_char_boundary(prefix) {
            prefix -= 1;
        }
        Plan {
            range: start + prefix..end,
            inserted: replacement[prefix..].to_owned(),
            caret,
            parsed: 0,
            carry: None,
        }
    }

    /// Input at display `range`: shaped by the formats the caret carries
    /// when the inline family takes it. A commit of marked text or a text
    /// service's replacement (`action` other than typing) replaces only the
    /// stretch of the display that differs from `text`, so characters it
    /// shares keep their source spelling and formats, and the caret ends
    /// after the whole of `text`. A text service's line break inside a table
    /// cell, a committed composition's included, becomes a space
    /// (`cell_service_text`). Input never lands inside an image, nor
    /// partly in a wikilink (`outside_atoms`), nor in front matter (`in_body`).
    pub(crate) fn plan_input(&self, range: DisplayRange, text: &str, action: InputAction) -> Plan {
        if self.block_selected && range == self.selection {
            return self.plan(range, text);
        }
        let range = self.outside_atoms(self.in_body(range));
        let flat = matches!(
            action,
            InputAction::Isolated | InputAction::CompositionCommit
        )
        .then(|| self.cell_service_text(range, text))
        .flatten();
        let text = flat.as_deref().unwrap_or(text);
        if let Some(typed) = self.formatted_input(range, text) {
            return Plan {
                range: typed.range,
                inserted: typed.inserted,
                caret: typed.caret,
                parsed: typed.parsed,
                carry: typed.carry,
            };
        }
        // Over a table it covers, nothing of the selection is kept, so no
        // shared stretch is either.
        if action == InputAction::Typing
            || range.start == range.end
            || self.whole_tables(range) != range
        {
            return self.plan(range, text);
        }
        let old = self.display_slice(range.start.0..range.end.0);
        // Over a code block the range reaches into or out of (which goes
        // whole), a text service's runs are one changed stretch, and it keeps
        // no text of a block it takes.
        let reach = self.block_reach(range);
        if action == InputAction::Isolated && reach.is_none() {
            return self.plan_runs(range, &old, text);
        }
        let (prefix, suffix) = changed_stretch(&old, text);
        let (prefix, suffix) = match reach {
            Some(_) => self.stretch_taking_blocks(range, prefix, suffix),
            None => (prefix, suffix),
        };
        // The caret ends where the display range ends, inside spans that
        // close there.
        let end = self.source_bounds(range.end.0).0;
        let start = DisplayOffset(range.start.0 + prefix);
        let stretch = DisplayRange {
            start,
            end: DisplayOffset(range.end.0 - suffix),
        };
        let inserted = &text[prefix..text.len() - suffix];
        let at = self.source_bounds(start.0).0;
        let plan = if stretch.start == stretch.end
            && self.empty_line(start.0).is_none()
            && !self.quote_space(at, inserted)
        {
            // Text added between kept characters lands after the one before
            // it, inside the spans that close there, as typing does.
            Plan {
                range: at..at,
                inserted: inserted.to_owned(),
                caret: at + inserted.len(),
                parsed: 0,
                carry: None,
            }
        } else {
            self.plan(stretch, inserted)
        };
        if suffix == 0 {
            return plan;
        }
        if plan.range.end > end {
            // The edit reaches past the kept end (a code fence it reopens):
            // replace through the range's end instead.
            let rest = DisplayRange { start, ..range };
            return self.plan(rest, &text[prefix..]);
        }
        let growth = plan.inserted.len() as isize - plan.range.len() as isize;
        Plan {
            caret: (end as isize + growth) as usize,
            ..plan
        }
    }
}

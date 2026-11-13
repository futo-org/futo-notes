//! Planning a replacement: which source bytes typing over a display
//! range writes, and where the caret lands.
use super::super::line::Role;
use super::super::{read, store, Engine};
use super::spans::Kept;
use crate::lines::Kind;
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

    /// Whether display offset `at` is on a line that shows with no text
    /// behind it, and that line's index.
    pub(crate) fn empty_line(&self, at: usize) -> Option<usize> {
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

    /// Replace display `range` with `text`. A collapsed caret inserts exactly
    /// `text` where it maps. A selection removes the visible text in it and
    /// the line markers and hidden lines inside it, keeps the syntax of spans
    /// that reach out of it, and drops the syntax of spans left empty; the
    /// text lands where the selection starts, inside spans that start there.
    /// Fences likewise: a fence line inside it whose block reaches out of it
    /// is kept, moved to just after the joined line, and a block left with
    /// no code line goes whole (`kept_frame`).
    pub(crate) fn plan(&self, range: DisplayRange, text: &str) -> Plan {
        let plan = self.replacement(range, text);
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
    /// caret maps, unless it is at a divider's edge.
    fn at_caret(&self, range: DisplayRange, inserted: String) -> Plan {
        let at = self.input_at(range);
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

    fn replacement(&self, range: DisplayRange, text: &str) -> Plan {
        let (s, e) = (range.start.0, range.end.0);
        let mut inserted = String::new();
        if s != e || !text.is_empty() {
            if let Some(index) = self.empty_line(s) {
                inserted.push_str(&self.empty_line_ending(index));
            }
        }
        inserted.push_str(text);
        if s == e {
            return self.at_caret(range, inserted);
        }
        let (lo_s, _) = self.source_span(s);
        let (_, hi_e) = self.source_span(e);
        let metadata_start = self.metadata_end().is_some() && s == 0;
        let from = if metadata_start {
            0
        } else {
            self.source_bounds(s).1
        };
        let lo_s = if metadata_start { 0 } else { lo_s };
        let to = self.source_bounds(e).0;

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
        // A fence frame line the selection cuts goes after the joined line.
        let (end, old) = match self.kept_frame(start, end) {
            Some((to, text)) => {
                replacement.push_str(&text);
                (to, self.source_slice(start..to))
            }
            None => (end, old),
        };
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
    /// (`cell_service_text`).
    pub(crate) fn plan_input(&self, range: DisplayRange, text: &str, action: InputAction) -> Plan {
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
        if action == InputAction::Typing || range.start == range.end {
            return self.plan(range, text);
        }
        let old = self.display_slice(range.start.0..range.end.0);
        if action == InputAction::Isolated {
            return self.plan_runs(range, &old, text);
        }
        let (prefix, suffix) = changed_stretch(&old, text);
        // The caret ends where the display range ends, inside spans that
        // close there.
        let end = self.source_bounds(range.end.0).0;
        let start = DisplayOffset(range.start.0 + prefix);
        let stretch = DisplayRange {
            start,
            end: DisplayOffset(range.end.0 - suffix),
        };
        let inserted = &text[prefix..text.len() - suffix];
        let plan = if stretch.start == stretch.end && self.empty_line(start.0).is_none() {
            // Text added between kept characters lands after the one before
            // it, inside the spans that close there, as typing does.
            let at = self.source_bounds(start.0).0;
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

impl Engine {
    /// A text service's replacement of display `range` (showing `old`)
    /// with `text`: each separate stretch that differs is replaced on its
    /// own, so the source between corrected words (hidden marks included)
    /// stays as it was. One plan spans them all; the caret ends after the
    /// whole of `text`.
    fn plan_runs(&self, range: DisplayRange, old: &str, text: &str) -> Plan {
        let byte = |text: &str| -> Vec<usize> {
            text.char_indices()
                .map(|(at, _)| at)
                .chain([text.len()])
                .collect()
        };
        let (old_at, new_at) = (byte(old), byte(text));
        let old_chars: Vec<char> = old.chars().collect();
        let new_chars: Vec<char> = text.chars().collect();
        let mut stretches: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        for op in similar::capture_diff_slices(similar::Algorithm::Myers, &old_chars, &new_chars) {
            let (tag, from, to) = op.as_tag_tuple();
            if tag == similar::DiffTag::Equal {
                continue;
            }
            let from = old_at[from.start]..old_at[from.end];
            let to = new_at[to.start]..new_at[to.end];
            match stretches.last_mut() {
                Some((was, now)) if was.end == from.start && now.end == to.start => {
                    was.end = from.end;
                    now.end = to.end;
                }
                _ => stretches.push((from, to)),
            }
        }
        let end = self.source_bounds(range.end.0).0;
        if stretches.is_empty() {
            return Plan {
                range: end..end,
                inserted: String::new(),
                caret: end,
                parsed: 0,
                carry: None,
            };
        }
        let plan_stretch = |from: &Range<usize>, to: &Range<usize>| {
            let stretch = DisplayRange {
                start: DisplayOffset(range.start.0 + from.start),
                end: DisplayOffset(range.start.0 + from.end),
            };
            let inserted = &text[to.clone()];
            if stretch.start == stretch.end && self.empty_line(stretch.start.0).is_none() {
                let at = self.source_bounds(stretch.start.0).0;
                Plan {
                    range: at..at,
                    inserted: inserted.to_owned(),
                    caret: at + inserted.len(),
                    parsed: 0,
                    carry: None,
                }
            } else {
                self.plan(stretch, inserted)
            }
        };
        // Stretches whose edits meet in the source (one reaches past the
        // next, as a fence line a joined line moves does) are one stretch,
        // so the source outside them stays as it was.
        type Planned = Vec<(Range<usize>, Range<usize>, Plan)>;
        let push = |planned: &mut Planned, mut from: Range<usize>, mut to: Range<usize>| {
            let mut plan = plan_stretch(&from, &to);
            while let Some((was, now, before)) = planned.last() {
                if plan.range.start >= before.range.end {
                    break;
                }
                from = was.start..from.end;
                to = now.start..to.end;
                planned.pop();
                plan = plan_stretch(&from, &to);
            }
            planned.push((from, to, plan));
        };
        let mut planned: Planned = Vec::new();
        for (from, to) in stretches {
            push(&mut planned, from, to);
        }
        let (from, to, last) = planned.last().expect("a stretch");
        if last.range.end > end && (from.end, to.end) != (old.len(), text.len()) {
            // The last edit reaches past the kept end (a code fence it
            // moves): it replaces through the range's end instead.
            let (from, to) = (from.start..old.len(), to.start..text.len());
            planned.pop();
            push(&mut planned, from, to);
        }
        let (from, to, _) = planned.last().expect("a stretch");
        let reaches_end = (from.end, to.end) == (old.len(), text.len());
        let plans: Vec<Plan> = planned.into_iter().map(|(_, _, plan)| plan).collect();
        let start = plans[0].range.start;
        let stop = plans[plans.len() - 1].range.end;
        let mut inserted = String::new();
        let mut at = start;
        for plan in &plans {
            inserted.push_str(&self.source_slice(at..plan.range.start));
            inserted.push_str(&plan.inserted);
            at = plan.range.end;
        }
        let growth = inserted.len() as isize - (stop - start) as isize;
        let last_plan = &plans[plans.len() - 1];
        let caret = if reaches_end {
            (last_plan.caret as isize + growth
                - (last_plan.inserted.len() as isize - last_plan.range.len() as isize))
                as usize
        } else {
            (end as isize + growth) as usize
        };
        Plan {
            range: start..stop,
            inserted,
            caret,
            parsed: plans.iter().map(|plan| plan.parsed).sum(),
            carry: None,
        }
    }
}

/// How many bytes `old` and `new` share at the start, and then at the end:
/// the stretch between is what a commit replaces.
pub(crate) fn changed_stretch(old: &str, new: &str) -> (usize, usize) {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = old[prefix..]
        .bytes()
        .rev()
        .zip(new[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    (prefix, suffix)
}

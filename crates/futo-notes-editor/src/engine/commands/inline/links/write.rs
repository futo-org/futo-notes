//! Writing new links: over a selection, at a caret, or with new text.
use super::super::super::super::command::{Command, Edit};
use super::super::super::super::line::Entry;
use super::super::super::super::Engine;
use super::super::draft::{glyph_range, glyphs, inside, regions, shape, Draft, Expect, LINK, URL};
use super::super::format::{wrap_marks, Marks};
use super::super::trimmed;
use super::{destination_in, links_to, spellings, Found};
use crate::lines::SpanKind;
use crate::{DisplayRange, EditorError};
use std::collections::BTreeMap;
use std::ops::Range;

impl Engine {
    /// Link the text `range` selects, one link per line and table cell.
    pub(super) fn link_selection(
        &self,
        range: DisplayRange,
        destination: &str,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        let mut edited = BTreeMap::new();
        let mut refused = false;
        let mut any = false;
        for body in self.bodies(range) {
            let regions = regions(body.entry);
            let mut draft = (Draft::of(body.entry), body.entry.clone());
            let mut expect: Vec<Expect> = body.glyphs.iter().map(Expect::same).collect();
            let line_shape = shape(body.entry);
            let mut ok = true;
            for region in &regions {
                let inside_region = glyph_range(&body.glyphs, region);
                let chosen: Vec<usize> = inside_region
                    .clone()
                    .filter(|&i| body.selected[i])
                    .collect();
                let (Some(&a), Some(&z)) = (chosen.first(), chosen.last()) else {
                    continue;
                };
                let mut run = trimmed(&body.glyphs, a..z + 1);
                if run.is_empty() {
                    continue;
                }
                any = true;
                match self.link_run(
                    &draft.0,
                    &draft.1,
                    &mut run,
                    &mut expect,
                    destination,
                    &line_shape,
                    work,
                ) {
                    Some(next) => draft = next,
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                refused = true;
                continue;
            }
            if draft.0.text != body.entry.text {
                edited.insert(body.index, draft);
            }
        }
        if edited.is_empty() {
            return if refused && any {
                Err(EditorError::UnrepresentableFormat)
            } else {
                Ok(None)
            };
        }
        Ok(self.rewrite(range, edited))
    }

    /// Wrap glyphs `run` of a line in one link to `destination`. A run that
    /// covers part of a link or an atom grows to cover it whole; links
    /// inside it are removed first (links do not nest).
    #[allow(clippy::too_many_arguments)]
    fn link_run(
        &self,
        draft: &Draft,
        entry: &Entry,
        run: &mut Range<usize>,
        expect: &mut [Expect],
        destination: &str,
        line_shape: &super::super::draft::Shape,
        work: &mut usize,
    ) -> Option<(Draft, Entry)> {
        let glyphs = glyphs(entry);
        // Grow over what the run cuts into.
        loop {
            let mut grew = false;
            for span in &entry.spans {
                if matches!(span.kind, SpanKind::Escape) {
                    continue;
                }
                let covered = glyph_range(&glyphs, &span.range);
                let covered = if matches!(span.kind, SpanKind::Link { .. }) {
                    glyph_range(&glyphs, &inside(span))
                } else if matches!(
                    span.kind,
                    SpanKind::Url { .. }
                        | SpanKind::Image { .. }
                        | SpanKind::Wikilink { .. }
                        | SpanKind::Tag
                        | SpanKind::Code
                ) {
                    covered
                } else {
                    continue;
                };
                if covered.start < run.end
                    && run.start < covered.end
                    && (covered.start < run.start || covered.end > run.end)
                {
                    run.start = run.start.min(covered.start);
                    run.end = run.end.max(covered.end);
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }
        // Remove the links inside it.
        let mut text = draft.text.clone();
        let mut cuts: Vec<Range<usize>> = entry
            .spans
            .iter()
            .filter(|span| matches!(span.kind, SpanKind::Link { .. }))
            .filter(|span| {
                let label = glyph_range(&glyphs, &inside(span));
                run.start <= label.start && label.end <= run.end
            })
            .flat_map(|span| [span.open.clone(), span.close.clone()])
            .collect();
        cuts.sort_by_key(|cut| std::cmp::Reverse(cut.start));
        let base = if cuts.is_empty() {
            (draft.clone(), entry.clone())
        } else {
            for cut in cuts {
                text.replace_range(cut, "");
            }
            let base = draft.with_text(text);
            let read = base.read(work);
            (base, read)
        };
        for i in run.clone() {
            expect[i].style = (expect[i].style & !URL) | LINK;
        }
        let marks = Marks {
            spellings: spellings(destination)
                .into_iter()
                .map(|spelled| ("[".to_owned(), format!("]({spelled})")))
                .collect(),
            innermost: false,
            literal: false,
        };
        let wanted = run.clone();
        let check = |read: &Entry| {
            let shown = super::super::draft::glyphs(read);
            read.spans.iter().any(|span| {
                matches!(&span.kind, SpanKind::Link { destination: to, .. } if to == destination)
                    && glyph_range(&shown, &inside(span)) == wanted
            })
        };
        wrap_marks(
            &base.0,
            &base.1,
            run.clone(),
            &marks,
            expect,
            line_shape,
            &check,
            work,
        )
    }

    /// Insert a link to `destination` at the caret: the address itself when
    /// it reads as one, else `[destination](destination)`; in a table cell
    /// its text writes a `|` as `\|`, as its destination does.
    pub(super) fn insert_link(
        &self,
        range: DisplayRange,
        destination: &str,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        let mut texts = vec![destination.to_owned()];
        let mut labels = vec![destination.to_owned()];
        if destination.contains('|') {
            labels.push(destination.replace('|', "\\|"));
        }
        for label in labels {
            texts.extend(
                spellings(destination)
                    .into_iter()
                    .map(|spelled| format!("[{label}]({spelled})")),
            );
        }
        for text in texts {
            if let Some(command) = self.written_link(range, &text, destination, work) {
                return Ok(Some(command));
            }
        }
        Err(EditorError::InvalidText)
    }

    /// Replace display `range` with `text` as typing over it would, when the
    /// line then reads a link to `destination` over all of `text` (any text
    /// when `destination` is empty). The caret ends after `text`.
    fn written_link(
        &self,
        range: DisplayRange,
        text: &str,
        destination: &str,
        work: &mut usize,
    ) -> Option<Command> {
        let plan = self.plan(range, text);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let start = self.line_start(first);
        let end_line = self.store.get(last);
        let end_start = self.line_start(last);
        let mut line = self.store.get(first).text[..plan.range.start - start].to_owned();
        line.push_str(&plan.inserted);
        line.push_str(&end_line.text[plan.range.end - end_start..]);
        let at = plan.range.start - start + plan.inserted.len() - text.len();
        if !destination.is_empty() {
            let read = Draft::of(self.store.get(first)).with_text(line).read(work);
            if !links_to(&read, &(at..at + text.len()), destination) {
                return None;
            }
        }
        Some(Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            plan.caret..plan.caret,
        ))
    }

    /// Write `label` (and `destination`) in place of the link `found`, or of
    /// display `target`. The caret ends after the label.
    pub(super) fn relabel(
        &self,
        found: Option<Found>,
        target: DisplayRange,
        label: &str,
        destination: &str,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        if label.is_empty() && found.is_none() && target.start == target.end {
            return Ok(None);
        }
        // The text to write, the caret's distance back from its end.
        let mut texts: Vec<(String, usize)> = Vec::new();
        if destination.is_empty() || label.is_empty() {
            texts.push((label.to_owned(), 0));
        } else {
            let title = found.as_ref().and_then(|found| {
                let entry = self.store.get(found.index);
                let SpanKind::Link { .. } = found.span.kind else {
                    return None;
                };
                let close = &entry.text[found.span.close.clone()];
                let at = destination_in(close);
                Some(close[at.end..close.len() - 1].to_owned())
            });
            let title = title.unwrap_or_default();
            for spelled in spellings(destination) {
                let tail = format!("]({spelled}{title})");
                texts.push((format!("[{label}{tail}"), tail.len()));
            }
        }
        for (text, back) in texts {
            let command = match &found {
                Some(found) => {
                    let start = self.line_start(found.index);
                    let entry = self.store.get(found.index);
                    let range = start + found.span.range.start..start + found.span.range.end;
                    let mut line = entry.text.clone();
                    line.replace_range(found.span.range.clone(), &text);
                    let at = found.span.range.start;
                    if !destination.is_empty() && !label.is_empty() {
                        let read = Draft::of(entry).with_text(line).read(work);
                        if !links_to(&read, &(at..at + text.len()), destination) {
                            continue;
                        }
                    }
                    let caret = range.start + text.len() - back;
                    Some(Command::new(
                        vec![Edit::new(range, text.clone())],
                        found.index..found.index + 1,
                        caret..caret,
                    ))
                }
                None => {
                    let check = if label.is_empty() { "" } else { destination };
                    self.written_link(target, &text, check, work)
                        .map(|mut command| {
                            let caret = command.selection.start - back;
                            command.selection = caret..caret;
                            command
                        })
                }
            };
            if let Some(command) = command {
                return Ok(Some(command));
            }
        }
        Err(EditorError::InvalidText)
    }
}

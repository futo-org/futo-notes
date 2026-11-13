//! Inline formatting and links.
//!
//! Inline marks open and close on one line, so every command here works one
//! line at a time: a selection over several lines formats (or links) each
//! line's text on its own, and each table cell's. A command tries a
//! spelling on a line and keeps it only when the line then reads as
//! intended (`draft.rs`); house spelling is `**`, `*`, `~~` and backticks.
//! A collapsed toggle writes nothing: it sets the formats typing at that
//! caret carries (`typing.rs`), until the caret moves; a deletion that
//! empties a span sets the span's formats there.
mod draft;
mod format;
mod links;
mod typing;

use super::super::command::{Command, Edit};
use super::super::line::Entry;
use super::super::{store, Engine};
use crate::{DisplayRange, EditorError, InlineFormat, Revision, SourceEdit, ViewChange};
use draft::{bit, formats_of, glyphs, inline_line, regions, Draft, Glyph};
use std::collections::BTreeMap;
use std::ops::Range;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// Lines a command rewrites: index to the new text and its reading.
type Edited = BTreeMap<usize, (Draft, Entry)>;

/// One line a command touches: its glyphs and which of them the selection
/// covers inside the line's inline text.
struct Body<'a> {
    index: usize,
    entry: &'a Entry,
    glyphs: Vec<Glyph>,
    selected: Vec<bool>,
}

impl Engine {
    /// The lines `range` touches that hold inline text, with the glyphs it
    /// selects.
    fn bodies(&self, range: DisplayRange) -> Vec<Body<'_>> {
        let mut out = Vec::new();
        for index in self.lines_of(range) {
            let entry = self.store.get(index);
            if !inline_line(entry) {
                continue;
            }
            let start = self.store.before(index).display;
            let regions = regions(entry);
            let glyphs = glyphs(entry);
            let selected = glyphs
                .iter()
                .map(|glyph| {
                    let at = start + glyph.display;
                    range.start.0 <= at
                        && at < range.end.0
                        && regions
                            .iter()
                            .any(|region| region.start <= glyph.src && glyph.src < region.end)
                })
                .collect();
            out.push(Body {
                index,
                entry,
                glyphs,
                selected,
            });
        }
        out
    }

    /// The source offset that shows at display `at` once `edited` lines are
    /// written.
    /// Formatting never changes the display, so the display offset holds.
    fn source_after(&self, at: usize, edited: &Edited) -> usize {
        let (index, before) = self.line_at_display(store::display, at);
        let shift: isize = edited
            .range(..index)
            .map(|(_, (draft, _))| draft.text.len() as isize)
            .sum::<isize>()
            - edited
                .range(..index)
                .map(|(&index, _)| self.store.get(index).text.len() as isize)
                .sum::<isize>();
        let local = match edited.get(&index) {
            Some((_, entry)) => entry
                .sources(at - before.display, true)
                .map_or(entry.body_len(), |(lo, _)| lo),
            None => self.source_bounds(at).0 - before.source,
        };
        (before.source as isize + shift) as usize + local
    }

    /// The command for `edited` lines, keeping display selection `range`.
    fn rewrite(&self, range: DisplayRange, edited: Edited) -> Option<Command> {
        let first = *edited.keys().next()?;
        let last = *edited.keys().next_back()?;
        let edits = edited
            .iter()
            .map(|(&index, (draft, _))| {
                let (range, text) = typing::difference(
                    self.line_start(index),
                    &self.store.get(index).text,
                    &draft.text,
                );
                Edit::new(range, text)
            })
            .collect();
        let selection =
            self.source_after(range.start.0, &edited)..self.source_after(range.end.0, &edited);
        Some(Command::new(edits, first..last + 1, selection))
    }

    /// Toggle `format` over display `range`: on every selected visible
    /// character unless all of them already carry it, then off everywhere.
    fn format_command(
        &self,
        range: DisplayRange,
        format: InlineFormat,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let bodies = self.bodies(range);
        let mark = bit(format);
        let mut chosen = bodies.iter().flat_map(|body| {
            body.glyphs
                .iter()
                .zip(&body.selected)
                .filter(|(glyph, selected)| **selected && !glyph.space())
                .map(|(glyph, _)| glyph.style & mark != 0)
        });
        let Some(first) = chosen.next() else {
            return Ok(None);
        };
        let add = !(first && chosen.all(|has| has));
        let mut edited = BTreeMap::new();
        let mut refused = false;
        for body in &bodies {
            if !body.selected.iter().any(|&selected| selected) {
                continue;
            }
            let want: Vec<bool> = body
                .glyphs
                .iter()
                .zip(&body.selected)
                .map(|(glyph, &selected)| {
                    if selected {
                        add
                    } else {
                        glyph.style & mark != 0
                    }
                })
                .collect();
            let first = body.selected.iter().position(|&selected| selected);
            let last = body.selected.iter().rposition(|&selected| selected);
            let touched = match (first, last) {
                (Some(first), Some(last)) => first..last + 1,
                _ => 0..0,
            };
            let draft = Draft::of(body.entry);
            match format::respell(&draft, body.entry, &want, touched, format, false, work) {
                Some((draft, read)) if draft.text != body.entry.text => {
                    edited.insert(body.index, (draft, read));
                }
                Some(_) => {}
                None => refused = true,
            }
        }
        if edited.is_empty() {
            return if refused {
                Err(EditorError::UnrepresentableFormat)
            } else {
                Ok(None)
            };
        }
        Ok(self.rewrite(range, edited))
    }

    /// The formats every selected visible character carries.
    pub(crate) fn selection_formats(&self) -> Vec<InlineFormat> {
        let mut style: Option<u16> = None;
        for body in self.bodies(self.selection) {
            for (glyph, selected) in body.glyphs.iter().zip(&body.selected) {
                if *selected && !glyph.space() {
                    style = Some(style.map_or(glyph.style, |style| style & glyph.style));
                }
            }
        }
        style.map_or_else(Vec::new, formats_of)
    }

    /// The formats the toolbar lights: the caret's, or those every selected
    /// character carries.
    pub(crate) fn toolbar_formats(&self) -> Vec<InlineFormat> {
        if self.selection.start == self.selection.end {
            self.active_formats()
        } else {
            self.selection_formats()
        }
    }

    /// The formats a deletion of display `range` (input of no text) keeps
    /// for the caret: those of its first character, as Cut keeps. `None`
    /// for other input, and where the caret already carries formats, which
    /// the deletion keeps.
    pub(crate) fn deleted_formats(
        &self,
        range: DisplayRange,
        text: &str,
    ) -> Option<Vec<InlineFormat>> {
        (text.is_empty() && range.start != range.end && self.formats.is_none())
            .then(|| self.formats_at(self.source_selection(range).start))
    }

    /// After a deletion, the caret carries `formats` (`deleted_formats`)
    /// where it no longer reads them, because the deletion emptied their
    /// span: the next character typed takes them, as in a rich-text editor.
    pub(crate) fn carry_deleted(&mut self, formats: Option<Vec<InlineFormat>>) {
        let Some(formats) = formats else {
            return;
        };
        if self.selection.start == self.selection.end
            && self.formats.is_none()
            && self.formats_at(self.caret_source()) != formats
        {
            self.formats = Some(formats);
        }
    }

    /// Whether inline commands apply: some line the selection or caret is
    /// on holds inline text (not code, front matter, a divider or a table's
    /// delimiter row).
    pub(crate) fn inline_allowed(&self) -> bool {
        self.lines_of(self.selection)
            .any(|index| inline_line(self.store.get(index)))
    }

    /// The toolbar's format toggle. A collapsed caret changes the formats
    /// typing there carries and writes nothing; a selection toggles the
    /// format over its text as one action. Marked text commits first.
    pub(crate) fn toggle_format_view(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let mut work = 0;
        // Marked text commits first; the caret then ends after it.
        let committed = if self.composition.is_some() {
            self.run(expected, |_| Ok(None), accept)?
        } else {
            None
        };
        let collapsed = self.selection.start == self.selection.end;
        let change = if collapsed {
            committed
        } else {
            self.run(
                self.revision,
                |engine| engine.format_command(engine.selection, format, &mut work),
                accept,
            )?
        };
        if collapsed && self.inline_allowed() {
            let mut formats = self.active_formats();
            match formats.iter().position(|have| *have == format) {
                Some(at) => {
                    formats.remove(at);
                }
                None => {
                    formats.push(format);
                    formats.sort();
                }
            }
            self.formats = Some(formats);
            self.typing = None;
        }
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += work;
            view
        }))
    }
}

/// Source `range` of a line's text as a range of its glyphs, trimmed of
/// spaces at both ends.
fn trimmed(glyphs: &[Glyph], mut run: Range<usize>) -> Range<usize> {
    while run.start < run.end && glyphs[run.start].space() {
        run.start += 1;
    }
    while run.end > run.start && glyphs[run.end - 1].space() {
        run.end -= 1;
    }
    run
}

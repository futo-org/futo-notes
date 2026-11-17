//! Inline formatting and links.
//!
//! Inline marks open and close on one line, so every command here works one
//! line at a time: a selection over several lines formats (or links) each
//! line's text on its own, and each table cell's. A command tries a
//! spelling on a line and keeps it only when the line then reads as
//! intended (`draft.rs`); house spelling is `**`, `*`, `~~` and backticks.
//! A collapsed toggle writes nothing: it sets the formats typing at that
//! caret carries (`typing.rs`), until the caret moves; a deletion that
//! empties a span sets the span's formats there. The mobile toolbar's
//! toggle instead formats the word a caret is inside or at the start of
//! (`word.rs`).
mod draft;
mod format;
mod links;
mod typing;
mod word;

use super::super::command::{Command, Edit};
use super::super::line::Entry;
use super::super::{store, Engine};
use crate::{DisplayRange, EditorError, InlineFormat, Revision, SourceEdit, ViewChange};
use draft::{
    bit, formats_of, glyphs, inline_line, regions, Draft, Glyph, BOLD, CODE, ITALIC, STRIKE,
};
use std::collections::BTreeMap;
use std::ops::Range;
use word::Landing;

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
    /// written: the lowest, or with `want` the highest on an edited line
    /// that reads as it asks, else the highest in the links it names.
    /// Formatting never changes the display, so the display offset holds.
    fn source_after(&self, at: usize, edited: &Edited, want: Option<&Landing>) -> usize {
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
            Some((_, entry)) => {
                entry
                    .sources(at - before.display, true)
                    .map_or(entry.body_len(), |(lo, hi)| {
                        want.and_then(|want| {
                            let places: Vec<(usize, Landing)> = (lo..=hi)
                                .rev()
                                .filter(|&p| entry.allowed(p))
                                .map(|p| (p, Landing::at(entry, p)))
                                .collect();
                            // Where it reads as asked, else at least in the
                            // same links.
                            places
                                .iter()
                                .find(|(_, landing)| landing == want)
                                .or_else(|| {
                                    places
                                        .iter()
                                        .find(|(_, landing)| landing.links == want.links)
                                })
                                .map(|(p, _)| *p)
                        })
                        .unwrap_or(lo)
                    })
            }
            None => self.source_bounds(at).0 - before.source,
        };
        (before.source as isize + shift) as usize + local
    }

    /// The command for `edited` lines, keeping display selection `range`.
    fn rewrite(&self, range: DisplayRange, edited: Edited) -> Option<Command> {
        self.rewrite_to(range, edited, None)
    }

    /// `rewrite`, with a caret landing where it reads `want` (`source_after`).
    fn rewrite_to(
        &self,
        range: DisplayRange,
        edited: Edited,
        want: Option<&Landing>,
    ) -> Option<Command> {
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
        let selection = self.source_after(range.start.0, &edited, want)
            ..self.source_after(range.end.0, &edited, want);
        Some(Command::new(edits, first..last + 1, selection))
    }

    /// Toggle `format` over display `range`: off everywhere when the
    /// selection has it (`selected_style`), else on every selected visible
    /// character, inline code aside for Bold, Italic and Strike. The
    /// selection afterwards is `keep`, a caret where it reads `want`.
    fn format_command(
        &self,
        range: DisplayRange,
        keep: DisplayRange,
        want: Option<&Landing>,
        format: InlineFormat,
        work: &mut usize,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let bodies = self.bodies(range);
        let Some(style) = selected_style(&bodies) else {
            return Ok(None);
        };
        let turn = FormatTurn {
            format,
            on: style & bit(format) == 0,
        };
        let edited = self.respelled_lines(&bodies, &[turn], work)?;
        if edited.is_empty() {
            return Ok(None);
        }
        Ok(self.rewrite_to(keep, edited, want))
    }

    /// `turns` applied in order over display `range`, as the toggles turn
    /// each, as one command; the selection stays. `None` when nothing
    /// changes.
    pub(crate) fn formats_turned(
        &self,
        range: DisplayRange,
        turns: &[FormatTurn],
    ) -> Result<Option<Command>, EditorError> {
        let edited = self.respelled_lines(&self.bodies(range), turns, &mut 0)?;
        if edited.is_empty() {
            return Ok(None);
        }
        Ok(self.rewrite(range, edited))
    }

    /// The lines of `bodies` with `turns` applied in order to their selected
    /// visible characters, inline code aside for Bold, Italic and Strike;
    /// only lines whose text changes. `UnrepresentableFormat` when some
    /// line cannot be spelled that way and none changes.
    fn respelled_lines(
        &self,
        bodies: &[Body],
        turns: &[FormatTurn],
        work: &mut usize,
    ) -> Result<Edited, EditorError> {
        let mut edited = BTreeMap::new();
        let mut refused = false;
        for body in bodies {
            if !body.selected.iter().any(|&selected| selected) {
                continue;
            }
            let first = body.selected.iter().position(|&selected| selected);
            let last = body.selected.iter().rposition(|&selected| selected);
            let touched = match (first, last) {
                (Some(first), Some(last)) => first..last + 1,
                _ => 0..0,
            };
            let mut current = Some((Draft::of(body.entry), body.entry.clone()));
            for turn in turns {
                current = current.and_then(|(draft, read)| {
                    let start = if turn.on && turn.format == InlineFormat::Code {
                        without_code_formats(draft, &read, &body.selected, &touched, work)
                    } else {
                        Some((draft, read))
                    };
                    let (draft, read) = start?;
                    let want = turned(&glyphs(&read), &body.selected, *turn);
                    format::respell(
                        &draft,
                        &read,
                        &want,
                        touched.clone(),
                        turn.format,
                        false,
                        work,
                    )
                });
            }
            match current {
                Some((draft, read)) if draft.text != body.entry.text => {
                    edited.insert(body.index, (draft, read));
                }
                Some(_) => {}
                None => refused = true,
            }
        }
        if edited.is_empty() && refused {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(edited)
    }

    /// The formats the selection has, which a toggle turns off
    /// (`selected_style`).
    pub(crate) fn selection_formats(&self) -> Vec<InlineFormat> {
        self.range_formats(self.selection)
    }

    /// The formats display `range` has, as a toggle over it reads them
    /// (`selected_style`).
    pub(crate) fn range_formats(&self, range: DisplayRange) -> Vec<InlineFormat> {
        selected_style(&self.bodies(range)).map_or_else(Vec::new, formats_of)
    }

    /// The formats the toolbar lights: the caret's, or the selection's
    /// (`selected_style`).
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
                |engine| {
                    let selection = engine.selection;
                    engine.format_command(selection, selection, None, format, &mut work)
                },
                accept,
            )?
        };
        if collapsed {
            self.toggle_carried(format);
        }
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += work;
            view
        }))
    }

    /// Toggle `format` in the formats typing at the collapsed caret carries.
    fn toggle_carried(&mut self, format: InlineFormat) {
        if self.inline_allowed() {
            let formats = self.active_formats();
            let on = !formats.contains(&format);
            let toggled = carried_with(formats.clone(), format, on);
            if toggled != formats {
                self.formats = Some(toggled);
                self.typing = None;
            }
        }
    }
}

/// `formats` a caret carries, with `format` turned on or off. Bold, Italic
/// and Strike do not turn on beside Code, and Code turned on drops them.
fn carried_with(
    mut formats: Vec<InlineFormat>,
    format: InlineFormat,
    on: bool,
) -> Vec<InlineFormat> {
    formats.retain(|have| *have != format);
    if on && format == InlineFormat::Code {
        return vec![InlineFormat::Code];
    }
    let refused = bit(format) & CODE_TAKES_NONE != 0 && formats.contains(&InlineFormat::Code);
    if on && !refused {
        formats.push(format);
        formats.sort();
    }
    formats
}

/// The formats a toggle never turns on for inline code's characters.
const CODE_TAKES_NONE: u16 = BOLD | ITALIC | STRIKE;

/// One format a command turns on or off over the selected characters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FormatTurn {
    pub format: InlineFormat,
    pub on: bool,
}

/// Which of `glyphs` carry `turn.format` once it is turned: the selected
/// ones as it says (inline code aside for Bold, Italic and Strike), the
/// rest as they are.
fn turned(glyphs: &[Glyph], selected: &[bool], turn: FormatTurn) -> Vec<bool> {
    let mark = bit(turn.format);
    let spares_code = mark & CODE_TAKES_NONE != 0;
    glyphs
        .iter()
        .zip(selected)
        .map(|(glyph, &selected)| {
            if selected && !(spares_code && glyph.style & CODE != 0) {
                turn.on
            } else {
                glyph.style & mark != 0
            }
        })
        .collect()
}

/// `entry`'s line with Bold, Italic and Strike taken off the `selected`
/// glyphs, before Code goes on over them. `None` when the line cannot read
/// that way.
fn without_code_formats(
    draft: Draft,
    entry: &Entry,
    selected: &[bool],
    touched: &Range<usize>,
    work: &mut usize,
) -> Option<(Draft, Entry)> {
    let mut current = (draft, entry.clone());
    for format in [
        InlineFormat::Bold,
        InlineFormat::Italic,
        InlineFormat::Strike,
    ] {
        let mark = bit(format);
        let want: Vec<bool> = glyphs(&current.1)
            .iter()
            .zip(selected)
            .map(|(glyph, &selected)| !selected && glyph.style & mark != 0)
            .collect();
        current = format::respell(
            &current.0,
            &current.1,
            &want,
            touched.clone(),
            format,
            false,
            work,
        )?;
    }
    Some(current)
}

/// The format bits the selected visible characters have, as a toggle reads
/// them: Code when every one is code; Bold, Italic and Strike when every one
/// outside inline code has it (none when all are code). `None` when no
/// visible character is selected.
fn selected_style(bodies: &[Body]) -> Option<u16> {
    let (mut every, mut outside_code, mut seen) = (u16::MAX, None, false);
    for body in bodies {
        for (glyph, &selected) in body.glyphs.iter().zip(&body.selected) {
            if !selected || glyph.space() {
                continue;
            }
            seen = true;
            every &= glyph.style;
            if glyph.style & CODE == 0 {
                outside_code = Some(outside_code.unwrap_or(u16::MAX) & glyph.style);
            }
        }
    }
    seen.then_some((every & !CODE_TAKES_NONE) | (outside_code.unwrap_or(0) & CODE_TAKES_NONE))
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

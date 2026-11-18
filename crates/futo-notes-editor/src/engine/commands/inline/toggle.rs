//! The toolbar's format toggle: over a selection it formats the selected
//! text; at a collapsed caret it changes the formats typing there carries.
use super::super::super::Engine;
use super::draft::formats_of;
use super::{bit, selected_style, Accept, Body, FormatTurn, CODE_TAKES_NONE};
use crate::{EditorError, InlineFormat, Revision, ToolbarCommand, ViewChange};

impl Engine {
    /// Whether inline commands apply: some line the selection or caret is
    /// on holds inline text they format (not code, front matter, a divider,
    /// a table's delimiter row, or a table line selected with other lines).
    pub(crate) fn inline_allowed(&self) -> bool {
        !self.formatted_lines(self.selection).is_empty()
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

    /// The formats the toolbar lights, and which of the toolbar's format
    /// toggles (`toggle_toolbar_format_view`) and Link would act, from one
    /// reading of the selected lines.
    pub(crate) fn inline_facts(&self) -> (Vec<InlineFormat>, Vec<ToolbarCommand>) {
        let collapsed = self.selection.start == self.selection.end;
        // At a caret the toolbar's toggle formats the word the caret is in.
        let word = if collapsed { self.caret_word() } else { None };
        let bodies = match (collapsed, word) {
            (true, None) => Vec::new(),
            (true, Some(word)) => self.bodies(word),
            (false, _) => self.bodies(self.selection),
        };
        let style = selected_style(&bodies);
        let formats = if collapsed {
            self.active_formats()
        } else {
            style.map_or_else(Vec::new, formats_of)
        };
        let mut allowed: Vec<ToolbarCommand> = [
            (InlineFormat::Bold, ToolbarCommand::Bold),
            (InlineFormat::Italic, ToolbarCommand::Italic),
            (InlineFormat::Strike, ToolbarCommand::Strike),
            (InlineFormat::Code, ToolbarCommand::Code),
        ]
        .into_iter()
        .filter(|&(format, _)| self.toggle_acts(format, &bodies, style))
        .map(|(_, command)| command)
        .collect();
        if self.link_acts(&bodies) {
            allowed.push(ToolbarCommand::Link);
        }
        (formats, allowed)
    }

    /// Whether the toolbar's toggle of `format` would act: over a selection
    /// or the word a caret is in (its lines `bodies`, which have `style`),
    /// change the note, the lines respelled one at a time until one changes
    /// (`format_command`'s own steps); at any other caret, change the formats
    /// typing there carries.
    fn toggle_acts(&self, format: InlineFormat, bodies: &[Body], style: Option<u16>) -> bool {
        if self.selection.start == self.selection.end && bodies.is_empty() {
            return self.carried_toggled(format).is_some();
        }
        let Some(style) = style else {
            return false;
        };
        let turn = FormatTurn {
            format,
            on: style & bit(format) == 0,
        };
        bodies.chunks(1).any(|body| {
            let edited = self.respelled_lines(body, &[turn], &mut 0);
            edited.is_ok_and(|edited| !edited.is_empty())
        })
    }

    /// Toggle `format` in the formats typing at the collapsed caret carries.
    pub(super) fn toggle_carried(&mut self, format: InlineFormat) {
        if let Some(toggled) = self.carried_toggled(format) {
            self.formats = Some(toggled);
            self.typing = None;
        }
    }

    /// The formats the collapsed caret carries with `format` toggled, when
    /// that changes them.
    fn carried_toggled(&self, format: InlineFormat) -> Option<Vec<InlineFormat>> {
        if !self.inline_allowed() {
            return None;
        }
        let formats = self.active_formats();
        let on = !formats.contains(&format);
        let toggled = carried_with(formats.clone(), format, on);
        (toggled != formats).then_some(toggled)
    }
}

/// `formats` a caret carries, with `format` turned on or off. Bold, Italic
/// and Strike do not turn on beside Code, and Code turned on drops them.
pub(super) fn carried_with(
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

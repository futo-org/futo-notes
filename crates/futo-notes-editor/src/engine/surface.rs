//! The engine in the surface's terms: view changes with their projection,
//! paragraph keys, toolbar state and UTF-16 input while text is marked.
//! `EditorSession` hands its editing path here under the `engine` feature.
use super::edit::Change;
use super::Engine;
use crate::{
    CaretDirection, DisplayOffset, DisplayRange, DisplayUtf16Range, EditWork, EditorError,
    InputAction, ParagraphKey, ProjectionSlice, Revision, SourceEdit, ToolbarList, ToolbarState,
    ViewChange,
};

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

impl Engine {
    /// A change as a view applies it, with the projection of every line it
    /// showed again.
    pub(crate) fn view(&self, change: Change) -> ViewChange {
        let lines = DisplayRange {
            start: DisplayOffset(change.lines.start),
            end: DisplayOffset(change.lines.end),
        };
        let projection = self.projection(change.edit.revision, lines);
        let mut work = change.work;
        work.inserted_bytes = change.edit.inserted.len();
        count_projection(&projection, &mut work);
        ViewChange {
            previous_revision: change.edit.previous_revision,
            revision: change.edit.revision,
            range: change.range,
            work,
            inserted: change.inserted,
            selection: change.selection,
            affinity: change.affinity,
            projection,
        }
    }

    pub(crate) fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        Ok(self.projection(expected, range))
    }

    /// The view change of input that changed nothing.
    pub(crate) fn unchanged(&self) -> ViewChange {
        let caret = DisplayRange {
            start: self.selection.start,
            end: self.selection.start,
        };
        ViewChange {
            previous_revision: self.revision,
            revision: self.revision,
            range: caret,
            inserted: String::new(),
            selection: self.selection,
            work: EditWork::default(),
            affinity: self.affinity,
            projection: self.projection(self.revision, caret),
        }
    }

    pub(crate) fn input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        action: InputAction,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        Ok(match self.replace(expected, range, text, action, accept)? {
            Some(change) => self.view(change),
            None => self.unchanged(),
        })
    }

    pub(crate) fn history_view(
        &mut self,
        expected: Revision,
        redo: bool,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let change = if redo {
            self.redo(expected, accept)?
        } else {
            self.undo(expected, accept)?
        };
        Ok(change.map(|change| self.view(change)))
    }

    pub(crate) fn commit_view(
        &mut self,
        expected: Revision,
        text: Option<&str>,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let change = self.commit_composition(expected, text, accept)?;
        Ok(change.map(|change| self.view(change)))
    }

    pub(crate) fn replay_view(
        &mut self,
        edit: &SourceEdit,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(edit.previous_revision)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let (start, end) = (edit.range.start.0, edit.range.end.0);
        if start > end || end > self.source_len() || self.source_slice(start..end) != edit.removed {
            return Err(EditorError::ReplayMismatch);
        }
        if edit.revision.0 != edit.previous_revision.0 + 1 {
            return Err(EditorError::ReplayMismatch);
        }
        match self.edit_source(edit.previous_revision, edit.range, &edit.inserted, accept)? {
            Some(change) => Ok(self.view(change)),
            None => Err(EditorError::ReplayMismatch),
        }
    }

    /// A paragraph key: the command a family claims it for on the lines it
    /// is pointed at, else typing (Enter writes the line's own line break;
    /// Backspace and Delete remove the range or one grapheme).
    pub(crate) fn key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            let change = self.run(
                expected,
                |engine| match engine.key_command(range, key)? {
                    Some(command) => Ok(Some(command)),
                    None => engine.typed_key(range, key),
                },
                accept,
            )?;
            return Ok(change.map(|change| self.view(change)));
        }
        self.check_display_range(range)?;
        if let Some(command) = self.key_command(range, key)? {
            let change = self.run(expected, |_| Ok(Some(command)), accept)?;
            return Ok(change.map(|change| self.view(change)));
        }
        let change = match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => {
                let (index, _) = self.line_at_display(super::store::display, range.start.0);
                let ending = self.empty_line_ending(index);
                self.replace(expected, range, &ending, InputAction::Typing, accept)?
            }
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::Delete => {
                if range != self.selection {
                    self.select_with_affinity(expected, range, self.affinity)?;
                }
                let direction = if key == ParagraphKey::Delete {
                    CaretDirection::Forward
                } else {
                    CaretDirection::Backward
                };
                self.delete(expected, direction, accept)?
            }
            ParagraphKey::Tab | ParagraphKey::ShiftTab => None,
        };
        Ok(change.map(|change| self.view(change)))
    }

    /// A toolbar block command, run behind the guard.
    pub(crate) fn block(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: crate::BlockCommand,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let change = self.run(
            expected,
            |engine| engine.block_command(range, command),
            accept,
        )?;
        Ok(change.map(|change| self.view(change)))
    }

    /// The display range of UTF-16 `range`; while text is marked, of the
    /// display with the marked text in place.
    pub(crate) fn input_from_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, EditorError> {
        self.check_revision(expected)?;
        let Some(marked) = &self.composition else {
            return self.display_from_utf16(expected, range);
        };
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        let start16 = self.display16(marked.range.start.0)?;
        let end16 = self.display16(marked.range.end.0)?;
        let text16 = marked.text.encode_utf16().count();
        let convert = |at: usize| -> Result<usize, EditorError> {
            if at <= start16 {
                self.display_from16(at)
            } else if at <= start16 + text16 {
                super::utf16_to_byte(&marked.text, at - start16)
                    .map(|local| marked.range.start.0 + local)
            } else {
                let real = self.display_from16(at - start16 - text16 + end16)?;
                Ok(real - marked.range.end.0 + marked.range.start.0 + marked.text.len())
            }
        };
        Ok(DisplayRange {
            start: DisplayOffset(convert(range.start.0)?),
            end: DisplayOffset(convert(range.end.0)?),
        })
    }

    /// What the toolbar shows for the caret's line: its formats, block and
    /// history. Commands are the next stage's; none is offered yet.
    pub(crate) fn toolbar(&self) -> ToolbarState {
        use crate::lines::{FenceRole, Kind};
        let entry = self.caret_line();
        let line = &entry.line;
        let code = matches!(
            line.kind,
            Kind::Fence {
                role: FenceRole::Code,
                ..
            }
        );
        ToolbarState {
            formats: self.active_formats(),
            heading: match line.kind {
                Kind::Heading { level } => Some(level),
                _ => None,
            },
            quote: line.quote > 0,
            list: match line.kind {
                Kind::List { task: Some(_), .. } => Some(ToolbarList::Task),
                Kind::List { ordered: true, .. } => Some(ToolbarList::Ordered),
                Kind::List { .. } => Some(ToolbarList::Bullet),
                _ => None,
            },
            code,
            mixed: false,
            inline_allowed: !code,
            can_indent: false,
            can_outdent: false,
            can_undo: self.can_undo(),
            can_redo: self.can_redo(),
        }
    }
}

/// Charge a projection's descriptions to `work`: one item per description
/// built, and the bytes of every target, destination and alt text copied.
fn count_projection(slice: &ProjectionSlice, work: &mut EditWork) {
    work.link_metadata_items += slice.runs.len()
        + slice.correspondence.len()
        + slice.blocks.len()
        + slice.links.len()
        + slice.wikilinks.len()
        + slice.atoms.len();
    let title = |title: &Option<String>| title.as_ref().map_or(0, String::len);
    work.link_copied_bytes += slice
        .links
        .iter()
        .map(|link| link.destination.len() + title(&link.title))
        .sum::<usize>()
        + slice
            .wikilinks
            .iter()
            .map(|wikilink| wikilink.target.len() + wikilink.label.len())
            .sum::<usize>()
        + slice
            .atoms
            .iter()
            .filter_map(|atom| atom.image.as_ref())
            .map(|image| image.alt.len() + image.destination.len() + title(&image.title))
            .sum::<usize>();
}

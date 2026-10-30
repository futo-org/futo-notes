//! Marked text is a provisional overlay over a pinned committed-display range.
use super::*;
use serde::{Deserialize, Serialize};

/// Views draw this overlay without interpreting markdown. Its range always
/// addresses committed display text, never the provisional string's offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Composition {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
}

impl EditorSession {
    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }

    /// Repeated updates retain the opening range. Hosts supply the complete
    /// marked string, including when a native IME replaces its last character.
    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let range = self
            .composition
            .as_ref()
            .map_or(range, |marked| marked.range);
        let marked = Composition {
            revision: expected,
            range,
            text: text.into(),
        };
        self.composition = Some(marked.clone());
        Ok(marked)
    }

    /// A changed native commit replaces the staged string. Failed recovery
    /// acceptance leaves the marked text available for retry or cancellation.
    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let Some(marked) = self.composition.clone() else {
            return Ok(None);
        };
        self.composition = None;
        match self.replace_os(
            expected,
            marked.range,
            text.unwrap_or(&marked.text),
            &[],
            accept,
        ) {
            Ok(change) => Ok(change),
            Err(error) => {
                self.composition = Some(marked);
                Err(error)
            }
        }
    }

    pub(crate) fn provisional_display(&self) -> Rope {
        let mut text = self.projection.display.clone();
        if let Some(marked) = &self.composition {
            let start = text.byte_to_char(marked.range.start.0);
            let end = text.byte_to_char(marked.range.end.0);
            text.remove(start..end);
            text.insert(start, &marked.text);
        }
        text
    }

    pub(super) fn input_during_composition(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        match self.finish_provisional_input(expected, range, inserted, action, accept)? {
            Some(change) => Ok(change),
            None => self.replace_action(
                expected,
                DisplayRange {
                    start: self.selection.end,
                    end: self.selection.end,
                },
                "",
                crate::InputAction::Isolated,
                accept,
            ),
        }
    }

    pub(super) fn finish_provisional_input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if action != crate::InputAction::Typing {
            let display = self.provisional_display();
            validate_overlay_range(&display, range)?;
            let old = display.byte_slice(range.start.0..range.end.0).to_string();
            let runs = os_replacement::differing_runs(&old, inserted, range.start.0);
            let targets: Vec<_> = runs
                .iter()
                .flat_map(|run| [run.range.start.0, run.range.end.0])
                .chain(std::iter::once(range.end.0))
                .collect();
            return self.command_during_composition_with_targets(
                expected,
                range,
                &targets,
                accept,
                |staged, targets, accept| {
                    let replacements: Vec<_> = runs
                        .iter()
                        .enumerate()
                        .map(|(index, run)| crate::DisplayReplacement {
                            range: DisplayRange {
                                start: DisplayOffset(targets[2 * index]),
                                end: DisplayOffset(targets[2 * index + 1]),
                            },
                            inserted: run.inserted.clone(),
                        })
                        .collect();
                    let mut caret = *targets.last().unwrap();
                    for run in &replacements {
                        caret = caret - (run.range.end.0 - run.range.start.0) + run.inserted.len();
                    }
                    let mut change = if replacements.is_empty() {
                        None
                    } else {
                        let (change, targets) = staged.replace_many_with_targets(
                            staged.revision(),
                            &replacements,
                            &[caret],
                            accept,
                        )?;
                        caret = targets[0];
                        Some(change)
                    };
                    staged.finish_os_selection(caret, change.as_mut());
                    Ok(change)
                },
            );
        }
        self.command_during_composition(expected, range, accept, |staged, local_range, accept| {
            staged
                .replace_action(staged.revision(), local_range, inserted, action, accept)
                .map(Some)
        })
    }

    /// Shared source-command arbitration. Commands run on an affected-window
    /// engine after the pending text commits, then one source record protects
    /// both actions while their exact history groups remain independent.
    pub(super) fn command_during_composition(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.command_during_composition_with_targets(
            expected,
            range,
            &[range.start.0, range.end.0],
            accept,
            |staged, targets, accept| {
                operation(
                    staged,
                    DisplayRange {
                        start: DisplayOffset(targets[0]),
                        end: DisplayOffset(targets[1]),
                    },
                    accept,
                )
            },
        )
    }

    fn command_during_composition_with_targets(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        targets: &[usize],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        operation: impl FnOnce(
            &mut Self,
            &[usize],
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let display = self.provisional_display();
        validate_overlay_range(&display, range)?;
        let marked = self.composition.as_ref().unwrap();
        let start = marked.range.start.0.min(range.start.0);
        let end = (marked.range.start.0 + marked.text.len()).max(range.end.0);
        let committed_end = end - marked.text.len() + marked.range.end.0 - marked.range.start.0;
        let full = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(committed_end),
        };
        let (window, display_start) = self.projection.edit_window(full);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let local = |range: DisplayRange| DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        let affinity = if marked.range == self.selection {
            self.affinity
        } else if marked.range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        staged.select_with_affinity(staged.revision(), local(marked.range), affinity)?;
        if marked.range == self.selection {
            staged.pending_formats = self.pending_formats.clone();
        }
        let mut transaction = crate::history::Transaction::new(&staged.source);
        let mut recorded = false;
        let mut capture = |edit: &SourceEdit| {
            recorded = true;
            transaction.apply(edit.range, &edit.inserted);
            Ok(())
        };
        let (first, targets) = staged.replace_os_with_targets(
            staged.revision(),
            local(marked.range),
            &marked.text,
            &targets
                .iter()
                .map(|offset| offset - display_start)
                .collect::<Vec<_>>(),
            &mut capture,
        )?;
        let second = operation(&mut staged, &targets, &mut capture)?;
        let selection = DisplayRange {
            start: DisplayOffset(display_start + staged.selection.start.0),
            end: DisplayOffset(display_start + staged.selection.end.0),
        };
        let mut change = None;
        if recorded {
            let (mut footprint, inserted) = transaction.finish();
            footprint.start.0 += window.start;
            footprint.end.0 += window.start;
            let edit = self.prepare_source(expected, footprint, &inserted)?;
            if edit.removed != edit.inserted {
                accept(&edit).map_err(EditorError::Persistence)?;
                for group in &mut staged.undo {
                    for entry in &mut group.entries {
                        entry.range.start.0 += window.start;
                        entry.range.end.0 += window.start;
                        entry.before_selection.start.0 += display_start;
                        entry.before_selection.end.0 += display_start;
                        entry.after_selection.start.0 += display_start;
                        entry.after_selection.end.0 += display_start;
                    }
                }
                let opening = &mut staged.undo.first_mut().unwrap().entries[0];
                opening.before_selection = self.selection;
                opening.before_affinity = self.affinity;
                opening.before_formats = self.pending_formats.clone();
                let mut delta = self.apply(&edit);
                delta.work.materialized_source_bytes += raw.len() + edit.inserted.len();
                delta.work.parsed_source_bytes += 2 * raw.len();
                for step in [first, second].into_iter().flatten() {
                    delta.work.materialized_source_bytes += step.work.materialized_source_bytes;
                    delta.work.parsed_source_bytes += step.work.parsed_source_bytes;
                }
                self.undo.append(&mut staged.undo);
                self.redo.clear();
                change = Some(delta);
            }
        }
        self.composition = None;
        self.selection = selection;
        self.affinity = staged.affinity;
        self.pending_formats = staged.pending_formats;
        self.typing = if change.is_some() {
            staged
                .typing
                .map(|run| run.relocate(display_start, self.clock.now()))
        } else {
            None
        };
        if let Some(delta) = &mut change {
            delta.selection = selection;
            delta.affinity = self.affinity;
        }
        Ok(change)
    }

    pub(super) fn compound_during_composition(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        if replacements.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        let display = self.provisional_display();
        let first = replacements.first().unwrap().range.start.0;
        let end = replacements.last().unwrap().range.end.0;
        for (index, replacement) in replacements.iter().enumerate() {
            validate_overlay_range(&display, replacement.range)?;
            if index > 0
                && (replacements[index - 1].range.end.0 > replacement.range.start.0
                    || replacements[index - 1].range.start == replacement.range.start)
            {
                return Err(EditorError::InvalidRange);
            }
        }
        // An entirely unchanged supplied run is selection-only. Retain every
        // changed run verbatim; do not rediscover its interior with a diff.
        let changed: Vec<_> = replacements
            .iter()
            .filter(|replacement| {
                display.byte_slice(replacement.range.start.0..replacement.range.end.0)
                    != replacement.inserted
            })
            .collect();
        let targets: Vec<_> = changed
            .iter()
            .flat_map(|replacement| [replacement.range.start.0, replacement.range.end.0])
            .chain(std::iter::once(end))
            .collect();
        let change = self.command_during_composition_with_targets(
            expected,
            DisplayRange {
                start: DisplayOffset(first),
                end: DisplayOffset(end),
            },
            &targets,
            accept,
            |staged, targets, accept| {
                // These are explicit caller-selected runs. Preserve their
                // identities through the marked commit rather than inferring
                // different runs from equal visible characters afterward.
                let replacements: Vec<_> = changed
                    .iter()
                    .enumerate()
                    .map(|(index, replacement)| crate::DisplayReplacement {
                        range: DisplayRange {
                            start: DisplayOffset(targets[2 * index]),
                            end: DisplayOffset(targets[2 * index + 1]),
                        },
                        inserted: replacement.inserted.clone(),
                    })
                    .collect();
                let mut caret = *targets.last().unwrap();
                for replacement in &replacements {
                    caret = caret - (replacement.range.end.0 - replacement.range.start.0)
                        + replacement.inserted.len();
                }
                let mut change = if replacements.is_empty() {
                    None
                } else {
                    let (change, targets) = staged.replace_many_with_targets(
                        staged.revision(),
                        &replacements,
                        &[caret],
                        accept,
                    )?;
                    caret = targets[0];
                    Some(change)
                };
                staged.finish_os_selection(caret, change.as_mut());
                Ok(change)
            },
        )?;
        match change {
            Some(change) => Ok(change),
            None => self.replace_action(
                expected,
                self.selection,
                "",
                crate::InputAction::Isolated,
                accept,
            ),
        }
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorError> {
        self.check_revision(expected)?;
        self.composition = None;
        Ok(())
    }
}

pub(super) fn validate_overlay_range(
    display: &Rope,
    range: DisplayRange,
) -> Result<(), EditorError> {
    if range.start.0 > range.end.0 {
        return Err(EditorError::InvalidRange);
    }
    for offset in [range.start.0, range.end.0] {
        let index = display
            .try_byte_to_char(offset)
            .map_err(|_| EditorError::InvalidRange)?;
        if display.char_to_byte(index) != offset {
            return Err(EditorError::InvalidRange);
        }
    }
    Ok(())
}

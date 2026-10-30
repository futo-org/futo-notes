//! A multi-run replacement is planned entirely before one host acceptance.
use super::*;
use crate::history::Transaction;
use crate::{DisplayReplacement, InputAction};
/// Sequential display replacements produced by one input. A structural boundary
/// is staged before the ordinary input; retain both locations instead of
/// reconstructing their identities from the combined source/display envelope.
pub(super) struct InputMapping {
    input: (DisplayRange, usize),
    boundary: Option<(DisplayRange, usize)>,
}

impl InputMapping {
    pub fn new(range: DisplayRange, inserted: usize) -> Self {
        Self {
            input: (range, inserted),
            boundary: None,
        }
    }

    pub fn with_boundary(mut self, change: &ViewChange, origin: usize) -> Self {
        self.boundary = Some((change.range, change.inserted.len()));
        for (range, _) in self
            .boundary
            .iter_mut()
            .chain(std::iter::once(&mut self.input))
        {
            range.start.0 += origin;
            range.end.0 += origin;
        }
        self
    }

    pub fn map(&self, mut offset: usize, origin: usize) -> Result<usize, EditorError> {
        for (range, inserted) in self.boundary.iter().chain(std::iter::once(&self.input)) {
            if offset >= origin + range.end.0 {
                offset = offset - (range.end.0 - range.start.0) + inserted;
            } else if offset > origin + range.start.0 {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(offset)
    }
}

/// A target in the intended replacement result belongs either to unchanged
/// opening text or to a specific inserted run. Keep that identity through the
/// protected structural replacements, including targets inside marked text.
struct SourceAnchor {
    display: usize,
    source: Option<usize>,
}

impl SourceAnchor {
    fn map(
        &mut self,
        edits: &[(SourceRange, usize)],
        mapping: &InputMapping,
        origin: usize,
        staged: &EditorSession,
        references_changed: bool,
    ) -> Result<usize, EditorError> {
        for (range, inserted) in edits {
            if let Some(source) = self.source {
                self.source = if source < range.start.0 {
                    Some(source)
                } else if range.end.0 <= source {
                    Some(source - (range.end.0 - range.start.0) + inserted)
                } else if source == range.start.0 {
                    Some(source)
                } else {
                    None
                };
            }
        }
        self.display = if let Some(source) = self.source {
            origin + staged.projection.display_at(source)
        } else if references_changed {
            // A rewritten source identity requires renderer correspondence;
            // display replacement arithmetic cannot cross global visibility.
            return Err(EditorError::UnrepresentableFormat);
        } else {
            let display = mapping.map(self.display, origin)?;
            if let Some(local) = display
                .checked_sub(origin)
                .filter(|local| *local <= staged.projection.display.len_bytes())
            {
                self.source = Some(
                    staged
                        .source_at(staged.revision(), DisplayOffset(local), Affinity::Forward)?
                        .0,
                );
            }
            display
        };
        Ok(1 + edits.len())
    }
}

enum ResultTarget {
    Opening(SourceAnchor),
    Inserted { run: usize, within: usize },
}

impl ResultTarget {
    fn new(replacements: &[DisplayReplacement], offset: usize) -> Self {
        let (mut old_end, mut new_end) = (0, 0);
        for (run, replacement) in replacements.iter().enumerate() {
            let start = new_end + replacement.range.start.0 - old_end;
            if offset < start {
                return Self::Opening(SourceAnchor {
                    display: offset + old_end - new_end,
                    source: None,
                });
            }
            if offset <= start + replacement.inserted.len() {
                return Self::Inserted {
                    run,
                    within: offset - start,
                };
            }
            old_end = replacement.range.end.0;
            new_end = start + replacement.inserted.len();
        }
        Self::Opening(SourceAnchor {
            display: offset + old_end - new_end,
            source: None,
        })
    }
}

impl EditorSession {
    /// Apply one user action whose nonoverlapping runs address the opening
    /// display. Unchanged runs retain their original source spelling. Empty,
    /// unordered, overlapping and invalid inputs reject without acceptance.
    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return self.compound_during_composition(expected, replacements, accept);
        }
        self.replace_many_with_targets(expected, replacements, &[], accept)
            .map(|(change, _)| change)
    }

    pub(super) fn replace_many_with_targets(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        targets: &[usize],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(ViewChange, Vec<usize>), EditorError> {
        if replacements.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        for (index, replacement) in replacements.iter().enumerate() {
            self.validate_range(replacement.range)?;
            if index > 0
                && (replacements[index - 1].range.end.0 > replacement.range.start.0
                    || replacements[index - 1].range.start == replacement.range.start)
            {
                return Err(EditorError::InvalidRange);
            }
        }
        let range = DisplayRange {
            start: replacements[0].range.start,
            end: replacements.last().unwrap().range.end,
        };
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone());
        let mut transaction = Transaction::new(&staged.source);
        let mut anchors: Vec<_> = replacements
            .iter()
            .flat_map(|replacement| [replacement.range.start.0, replacement.range.end.0])
            .map(|offset| {
                Ok(SourceAnchor {
                    display: offset - display_start,
                    source: Some(
                        self.source_at(expected, DisplayOffset(offset), Affinity::Forward)?
                            .0
                            - window.start,
                    ),
                })
            })
            .collect::<Result<_, EditorError>>()?;
        let mut targets: Vec<_> = targets
            .iter()
            .map(|&offset| ResultTarget::new(replacements, offset))
            .collect();
        for target in &mut targets {
            if let ResultTarget::Opening(anchor) = target {
                anchor.source = self
                    .source_at(expected, DisplayOffset(anchor.display), Affinity::Forward)?
                    .0
                    .checked_sub(window.start)
                    .filter(|source| *source <= raw.len());
            }
        }
        let mut materialized = raw.len();
        let mut parsed = staged.projection.initial_parse_work;
        let mut link_metadata_items = staged.projection.initial_link_metadata_items;
        let mut link_copied_bytes = staged.projection.initial_link_copied_bytes;
        for (index, replacement) in replacements.iter().enumerate() {
            let local_range = DisplayRange {
                start: DisplayOffset(anchors[2 * index].display),
                end: DisplayOffset(anchors[2 * index + 1].display),
            };
            let affinity = if replacement.range == self.selection {
                self.affinity
            } else if replacement.range.start.0 == 0 {
                Affinity::Forward
            } else {
                Affinity::Backward
            };
            staged.select_with_affinity(staged.revision(), local_range, affinity)?;
            if replacement.range == self.selection {
                staged.pending_formats = self.pending_formats.clone();
            }
            let references = staged.projection.references.clone();
            let mut edits = Vec::new();
            let (change, mapping) = staged.replace_action_mapped(
                staged.revision(),
                local_range,
                &replacement.inserted,
                InputAction::Isolated,
                &mut |edit| {
                    edits.push((edit.range, edit.inserted.len()));
                    transaction.apply(edit.range, &edit.inserted);
                    Ok(())
                },
            )?;
            let references_changed = !Arc::ptr_eq(&references, &staged.projection.references);
            link_metadata_items += edits.len();
            for anchor in &mut anchors[2 * index + 2..] {
                link_metadata_items +=
                    anchor.map(&edits, &mapping, 0, &staged, references_changed)?;
            }
            for target in &mut targets {
                match target {
                    ResultTarget::Opening(anchor) => {
                        link_metadata_items += anchor.map(
                            &edits,
                            &mapping,
                            display_start,
                            &staged,
                            references_changed,
                        )?;
                    }
                    ResultTarget::Inserted { run, within } if *run == index => {
                        let at = staged.selection.end.0 - replacement.inserted.len() + *within;
                        *target = ResultTarget::Opening(SourceAnchor {
                            display: display_start + at,
                            source: Some(
                                staged
                                    .source_at(
                                        staged.revision(),
                                        DisplayOffset(at),
                                        Affinity::Forward,
                                    )?
                                    .0,
                            ),
                        });
                    }
                    _ => {}
                }
            }
            materialized += change.work.materialized_source_bytes;
            parsed += change.work.parsed_source_bytes;
            link_metadata_items += change.work.link_metadata_items;
            link_copied_bytes += change.work.link_copied_bytes;
        }
        let targets = targets
            .into_iter()
            .map(|target| match target {
                ResultTarget::Opening(anchor) => anchor.display,
                ResultTarget::Inserted { .. } => unreachable!("every inserted run was staged"),
            })
            .collect();
        let (mut range, inserted) = transaction.finish();
        range.start.0 += window.start;
        range.end.0 += window.start;
        let edit = self.prepare_source(expected, range, &inserted)?;
        // No host-visible changes, history or clock boundaries before acceptance.
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let mut change = self.apply(&edit);
        self.selection = DisplayRange {
            start: DisplayOffset(display_start + staged.selection.start.0),
            end: DisplayOffset(display_start + staged.selection.end.0),
        };
        self.affinity = staged.affinity;
        self.pending_formats = staged.pending_formats;
        change.selection = self.selection;
        change.affinity = self.affinity;
        change.work.materialized_source_bytes += materialized + edit.inserted.len();
        change.work.parsed_source_bytes += parsed;
        change.work.link_metadata_items += link_metadata_items;
        change.work.link_copied_bytes += link_copied_bytes;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: self.pending_formats.clone(),
                after_links,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            }],
        });
        self.redo.clear();
        self.typing = None;
        Ok((change, targets))
    }
}

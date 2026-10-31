//! One command-local source emitter over immutable original ownership plans.
use super::super::{indent_source, list_lift_plan, list_styles, list_targets, transaction};
use super::*;
use crate::inline::blocks::ListCommandLine;
use std::{collections::HashMap, ops::Range};
mod heads;
mod prefixes;

pub(super) struct PlannedListSource {
    pub footprint: Range<usize>,
    pub output: String,
    pub selection: DisplayRange,
    pub work: EditWork,
}

struct ListEmitter<'a> {
    session: &'a EditorSession,
    lines: &'a [ListCommandLine],
    range: DisplayRange,
    command: BlockCommand,
    targets: &'a list_targets::ListTargets,
    remove: bool,
    styles: Option<list_styles::ListStylePlan>,
    lift: list_lift_plan::MixedLiftPlan,
    start: usize,
    end: usize,
    raw: String,
    replacements: Vec<(Range<usize>, String)>,
    parsed: usize,
    materialized: usize,
    heads: HashMap<usize, (usize, bool)>,
    shifts: Vec<indent_source::OwnedPrefixShift>,
    selection: DisplayRange,
    separators: Vec<usize>,
    preview_header: bool,
}

impl EditorSession {
    pub(super) fn scoped_list_source(
        &self,
        range: DisplayRange,
        lines: &[ListCommandLine],
        command: BlockCommand,
        scope: LiftScope,
        targets: &list_targets::ListTargets,
        remove: bool,
    ) -> Result<PlannedListSource, EditorError> {
        let session = self;
        let styles = (!remove).then(|| session.list_styles(lines, command, targets));
        let lift_plan = if !remove && scope == LiftScope::AllAncestors {
            session.mixed_lift_plan(lines, command, targets, styles.as_ref().unwrap())?
        } else {
            list_lift_plan::MixedLiftPlan::default()
        };
        let start = lines.first().unwrap().source.start;
        let owned_end = if remove {
            0
        } else {
            lines
                .iter()
                .filter(|line| !targets.removes(line))
                .filter_map(|line| line.list.as_ref())
                .map(|list| list.item.end)
                .max()
                .unwrap_or(0)
        };
        let end = lines.last().unwrap().source.end.max(owned_end).max(
            styles
                .as_ref()
                .and_then(|styles| styles.comments.iter().map(|(at, _)| *at).max())
                .unwrap_or(0),
        );
        let output = session.source.byte_slice(start..end).to_string();
        let replacements: Vec<_> = styles
            .as_ref()
            .map(|styles| {
                styles
                    .comments
                    .iter()
                    .map(|(at, text)| (at - start..at - start, text.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let parsed = lift_plan.parsed;
        let materialized = output.len()
            + lift_plan.materialized
            + styles.as_ref().map_or(0, |styles| {
                styles.materialized
                    + styles
                        .comments
                        .iter()
                        .map(|(_, comment)| {
                            crate::inline::visit_container();
                            comment.len()
                        })
                        .sum::<usize>()
            });
        let mut emitter = ListEmitter {
            session,
            lines,
            range,
            command,
            targets,
            remove,
            styles,
            lift: lift_plan,
            start,
            end,
            raw: output,
            replacements,
            parsed,
            materialized,
            heads: HashMap::new(),
            shifts: Vec::new(),
            selection: range,
            separators: Vec::new(),
            preview_header: false,
        };
        for (index, line) in lines.iter().enumerate() {
            emitter.emit_head(index, line)?;
        }
        emitter.emit_owned_prefixes()?;
        emitter.finish()
    }
}

impl ListEmitter<'_> {
    fn finish(mut self) -> Result<PlannedListSource, EditorError> {
        if !self.remove {
            if let Some((separator, work)) = self.session.list_neighbor_separator(
                self.end,
                self.styles.as_ref().unwrap().quotes[self.lines.len() - 1],
            ) {
                self.materialized += work;
                self.replacements
                    .push((self.end - self.start..self.end - self.start, separator));
                self.separators
                    .push(self.session.projection.display_at(self.end));
            }
        }
        for endpoint in [&mut self.selection.start.0, &mut self.selection.end.0] {
            *endpoint += self
                .separators
                .iter()
                .filter(|&&at| at <= *endpoint)
                .count();
        }
        self.replacements
            .sort_by_key(|(range, _)| (range.start, range.end));
        let output = transaction::spell_edits(&self.raw, &self.replacements)?;
        let mut work = EditWork {
            parsed_source_bytes: self.parsed,
            materialized_source_bytes: self.materialized,
            ..EditWork::default()
        };
        if self.preview_header {
            let (mapped, preview_work) = self.session.preview_header_selection(
                self.range,
                self.start..self.end,
                &self.replacements,
                &output,
                None,
            )?;
            self.selection = mapped;
            accumulate_planning_work(&mut work, preview_work);
        }
        Ok(PlannedListSource {
            footprint: self.start..self.end,
            output,
            selection: self.selection,
            work,
        })
    }
}

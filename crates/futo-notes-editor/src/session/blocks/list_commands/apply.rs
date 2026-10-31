use super::*;

impl EditorSession {
    pub(super) fn scoped_list_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        scope: LiftScope,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let mut lines = self.selected_list_lines(range);
        let targets = super::super::list_targets::ListTargets::new(
            &lines,
            command,
            scope == LiftScope::AllAncestors,
        );
        self.expand_list_scope(&targets, &mut lines);
        let remove = lines.iter().all(|line| targets.removes(line));
        if lines.is_empty() {
            return Ok(None);
        }
        if self.projection.has_block_seams(range)
            || self
                .projection
                .has_multiline_block_code(&self.source, range)
        {
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let seams = staged.split_inline_block_seams(local, accept)?;
                    let Some(mut change) = staged.scoped_list_command(
                        staged.revision(),
                        local,
                        command,
                        scope,
                        accept,
                    )?
                    else {
                        return Ok(None);
                    };
                    if let Some(seams) = seams {
                        change.work.materialized_source_bytes +=
                            seams.work.materialized_source_bytes;
                        change.work.parsed_source_bytes += seams.work.parsed_source_bytes;
                        change.work.link_metadata_items += seams.work.link_metadata_items;
                        change.work.link_copied_bytes += seams.work.link_copied_bytes;
                    }
                    Ok(Some(change))
                },
            );
        }
        if remove
            && scope == LiftScope::AllAncestors
            && lines
                .first()
                .and_then(|line| line.list.as_ref())
                .is_some_and(|list| list.outer_depth > 1)
        {
            return self.lift_crossquote_list(expected, range, &lines, accept);
        }
        if remove
            && scope == LiftScope::AllAncestors
            && lines
                .first()
                .and_then(|line| line.list.as_ref())
                .is_some_and(|list| list.parent_marker.is_some() || targets.covered_descendants)
        {
            return self.lift_nested_list(expected, range, &lines, accept);
        }
        let plan = self.scoped_list_source(range, &lines, command, scope, &targets, remove)?;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            plan.footprint,
            &plan.output,
            BlockSelection::Display(plan.selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += plan.parsed;
        change.work.materialized_source_bytes += plan.materialized;
        Ok(Some(change))
    }
    fn expand_list_scope(
        &self,
        targets: &super::super::list_targets::ListTargets,
        lines: &mut Vec<crate::inline::blocks::ListCommandLine>,
    ) {
        for item in targets.retired_items() {
            lines.extend(
                self.projection
                    .list_command_lines_in_source(item)
                    .into_iter()
                    .filter(|line| {
                        !line.code && line.list.as_ref().is_some_and(|list| list.item == *item)
                    }),
            );
        }
        for owner in targets.changed_owners() {
            lines.extend(
                self.projection
                    .list_command_lines_in_source(owner)
                    .into_iter()
                    .filter(|line| {
                        !line.code
                            && line
                                .list
                                .as_ref()
                                .is_some_and(|list| list.first && list.owner == *owner)
                    }),
            );
        }
        lines.retain(|line| targets.applies(line));
        lines.sort_by_key(|line| {
            crate::inline::visit_container();
            line.source.start
        });
        lines.dedup_by_key(|line| {
            crate::inline::visit_container();
            line.source.start
        });
    }
}

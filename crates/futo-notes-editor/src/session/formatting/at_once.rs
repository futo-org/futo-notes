//! A multi-body toggle planned in one pass over the unchanged note.
//!
//! The staged sequence applies each body's toggle before planning the next,
//! reparsing and projecting every body twice. When no body's plan reads text
//! another body's edit changed, and the window holds no transient link or
//! word fields to carry, each plan is the same against the unchanged note,
//! so all of them are planned first and applied once.
use super::bodies::Body;
use super::*;
use crate::inline::{EditIntent, Plan};
use std::ops::Range;

/// Cell count past which a table is never planned in one pass.
const MANY_CELLS: usize = 64;

/// One body's plan: `None` when the staged sequence must decide instead.
enum Planned {
    Edit(Box<Plan>),
    /// The body cannot take the format; nothing changes for it.
    Refused,
}

impl EditorSession {
    pub(super) fn carries_format(&self, range: DisplayRange, format: InlineFormat) -> bool {
        self.projection.selection_formats(range).contains(&format)
    }

    /// The whole toggle as one source edit and its planning work, or `None`
    /// when a plan cannot be shown independent of the others' edits.
    pub(super) fn plan_bodies_at_once(
        &self,
        format: InlineFormat,
        add: bool,
        bodies: &[Body],
        carried: &[bool],
    ) -> Option<(SourceRange, String, EditWork)> {
        let (window, _) = self.projection.edit_window(self.selection);
        if self.projection.pending_links(window).has_fields() {
            return None;
        }
        // Cells of one table all read the whole table as their context, so
        // their plans never read as independent: planning each of many only
        // to find that out costs cells times table size.
        if bodies.len() > MANY_CELLS && bodies.iter().all(|body| body.cell) {
            return None;
        }
        let mut edits: Vec<(Range<usize>, String)> = Vec::new();
        let mut work = EditWork::default();
        let mut applied = false;
        // Where the last planned context ended: a later plan may not read it.
        let mut read_to = 0;
        // Bodies are independent until proven otherwise below: plan them all
        // at once, across cores where there are any.
        let (projection, source) = (&self.projection, &self.source);
        let targets: Vec<_> = bodies.iter().zip(carried).collect();
        let planned = crate::parallel::map(&targets, |(body, carried)| {
            (!(add && **carried))
                .then(|| plan_body(projection, source, body.range, format, add, body.cell))
        });
        let mut take = |planned: Option<Planned>, work: &mut EditWork| -> Option<bool> {
            match planned? {
                Planned::Refused => Some(false),
                Planned::Edit(plan) => {
                    if plan.context.start < read_to
                        || edits
                            .last()
                            .is_some_and(|(last, _)| plan.range.start < last.end)
                    {
                        return None;
                    }
                    read_to = plan.context.end;
                    accumulate_planning_work(work, plan_work(&plan));
                    if !plan.range.is_empty() || !plan.inserted.is_empty() {
                        edits.push((plan.range, plan.inserted));
                    }
                    Some(true)
                }
            }
        };
        for (body, planned) in bodies.iter().zip(planned) {
            // `None`: the body already carries the format being added.
            let Some(planned) = planned else { continue };
            if take(planned, &mut work)? {
                applied = true;
            } else if body.lines.len() > 1 {
                for &line in &body.lines {
                    if !(add && self.carries_format(line, format)) {
                        let planned = plan_body(projection, source, line, format, add, body.cell);
                        applied |= take(planned, &mut work)?;
                    }
                }
            }
        }
        if !applied || edits.is_empty() {
            return None;
        }
        let start = edits[0].0.start;
        let end = edits[edits.len() - 1].0.end;
        let mut inserted = String::with_capacity(end - start + 4 * edits.len());
        let mut at = start;
        for (range, text) in &edits {
            inserted.extend(self.source.byte_slice(at..range.start).chunks());
            inserted.push_str(text);
            at = range.end;
        }
        work.materialized_source_bytes += end - start;
        Some((
            SourceRange {
                start: SourceOffset(start),
                end: SourceOffset(end),
            },
            inserted,
            work,
        ))
    }
}

/// Plan one body as the staged toggle would, without applying it. Reads
/// only the projection and source, so bodies can be planned in parallel.
fn plan_body(
    projection: &crate::inline::Projection,
    source: &ropey::Rope,
    range: DisplayRange,
    format: InlineFormat,
    add: bool,
    cell: bool,
) -> Option<Planned> {
    let range = projection.outside_metadata(range);
    let plan = match projection.edit(
        source,
        range,
        "",
        Affinity::Forward,
        None,
        EditIntent::Toggle(format, Some(add)),
    ) {
        Ok(plan) => plan,
        Err(EditorError::UnrepresentableFormat) => return Some(Planned::Refused),
        Err(_) => return None,
    };
    // Transient link, delimiter and word fields are carried by the staged
    // sequence's exact pending transfer only.
    let plain = plan.pending_links.is_empty()
        && plan.activated_links.is_empty()
        && plan.delimiters.is_empty()
        && plan.guarded_words.is_none()
        && plan.split_retirement.is_none()
        && plan.context.start <= plan.range.start
        && plan.range.end <= plan.context.end;
    if !plain {
        return None;
    }
    // A cell's markers may never add or remove a cell boundary.
    if cell {
        let removed = source.byte_slice(plan.range.clone()).to_string();
        if crate::table::pipe_count(&removed) != crate::table::pipe_count(&plan.inserted)
            || plan.inserted.contains(['\r', '\n'])
        {
            return Some(Planned::Refused);
        }
    }
    Some(Planned::Edit(Box::new(plan)))
}

fn plan_work(plan: &Plan) -> EditWork {
    EditWork {
        materialized_source_bytes: plan.materialized,
        parsed_source_bytes: plan.parsed,
        link_metadata_items: plan.link_metadata_items,
        link_copied_bytes: plan.link_copied_bytes,
        ..EditWork::default()
    }
}

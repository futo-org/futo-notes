//! The candidate must reparse to exactly the intended rows and display.
use super::*;

fn shown(projection: &crate::inline::Projection, range: Range<usize>) -> String {
    let start = projection.display_at(range.start);
    let end = projection.display_at(range.end).max(start);
    projection.display.byte_slice(start..end).to_string()
}

impl EditorSession {
    /// The first row whose reparsed shape or display differs, if any.
    pub(super) fn verify_rows(
        &self,
        expected: Revision,
        window: &Range<usize>,
        rows: &[Row],
        plan: &Plan,
        work: &mut EditWork,
    ) -> Result<Option<usize>, EditorError> {
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.span.start),
                end: SourceOffset(plan.span.end),
            },
            &plan.text,
        )?;
        let (whole, wanted) = self.intended_display(window, rows);
        let (found, used) = self.with_exact_candidate(&edit, window.clone(), |staged| {
            let projection = &staged.projection;
            let lines = projection.list_command_lines_in_source(&(0..staged.source.len_bytes()));
            // Lists the intent keeps apart must not merge.
            let mut owners: Vec<(usize, usize)> = Vec::new();
            for (index, row) in rows.iter().enumerate() {
                let (line, body) = plan.starts[index];
                let delta = plan.escapes[index].map_or(0, |(_, delta)| delta);
                let end = (body + row.body.len()).saturating_add_signed(delta) - window.start;
                if shown(projection, body - window.start..end) != wanted[index] {
                    return Ok(Some(index));
                }
                let line = line - window.start;
                let found = lines
                    .binary_search_by_key(&line, |candidate| candidate.source.start)
                    .ok()
                    .map(|at| &lines[at]);
                let merged = found
                    .and_then(|candidate| candidate.list.as_ref())
                    .filter(|_| row.after.opens && !row.blank)
                    .is_some_and(|list| {
                        match owners.iter().find(|(owner, _)| *owner == list.owner.start) {
                            Some((_, key)) => *key != row.key,
                            None => {
                                owners.push((list.owner.start, row.key));
                                false
                            }
                        }
                    });
                if merged || !same_row(row, line, found) {
                    return Ok(Some(index));
                }
            }
            Ok((staged.display_text() != whole).then_some(rows.len() - 1))
        })?;
        accumulate_planning_work(work, used);
        Ok(found)
    }

    /// Every row's body and ending in order with prefixes hidden, plus each
    /// inserted blank line; and each row's own body display.
    fn intended_display(&self, window: &Range<usize>, rows: &[Row]) -> (String, Vec<String>) {
        let first = rows.first().map_or(window.end, |row| row.line.start);
        let mut whole = shown(&self.projection, window.start..first);
        let mut wanted = Vec::with_capacity(rows.len());
        let mut previous = first;
        for row in rows {
            whole.push_str(&shown(&self.projection, previous..row.line.start));
            if row.insert == Insert::Blank {
                let ending = self.source.byte_slice(row.line.end..row.end).to_string();
                whole.push_str(if ending.is_empty() { "\n" } else { &ending });
            }
            let text = shown(&self.projection, row.body.clone());
            whole.push_str(&text);
            whole.push_str(&shown(&self.projection, row.body.end..row.end));
            wanted.push(text);
            previous = row.end;
        }
        whole.push_str(&shown(&self.projection, previous..window.end));
        (whole, wanted)
    }
}

/// The reparsed row has the intended host-visible block shape.
fn same_row(
    row: &Row,
    line: usize,
    found: Option<&crate::inline::blocks::ListCommandLine>,
) -> bool {
    let Some(candidate) = found else {
        return row.blank;
    };
    if row.blank {
        return !row.exact_blank || candidate.list.is_none();
    }
    let shape = &row.after;
    candidate.quote_depth == shape.quotes
        && candidate.heading == shape.heading
        && candidate.code == row.code
        && candidate.divider == row.divider
        && match &candidate.list {
            None => shape.depth == 0,
            Some(list) => {
                let opens = list.first && list.marker.start >= line;
                list.depth == shape.depth
                    && opens == shape.opens
                    && (!opens || list.ordinal == shape.ordinal && list.checked == shape.checked)
            }
        }
}

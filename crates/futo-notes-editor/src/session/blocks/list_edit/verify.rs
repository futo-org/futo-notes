//! The candidate must reparse to exactly the intended rows and display.
use super::*;

fn shown(projection: &crate::inline::Projection, range: Range<usize>) -> String {
    let start = projection.display_at(range.start);
    let end = projection.display_at(range.end).max(start);
    projection.display.byte_slice(start..end).to_string()
}

/// Inline semantics of one body, relative to its display start: formatted
/// runs, links, wikilinks and atoms (merged so run boundaries cannot differ).
#[derive(PartialEq, Eq)]
struct Inline {
    runs: Vec<(usize, usize, Vec<InlineFormat>)>,
    links: Vec<(usize, usize, String, Option<String>)>,
    wikilinks: Vec<(usize, usize, String)>,
    atoms: Vec<(usize, usize)>,
}

fn inline(projection: &crate::inline::Projection, body: Range<usize>) -> Inline {
    let start = projection.display_at(body.start);
    let end = projection.display_at(body.end).max(start);
    let slice = projection.query(
        Revision(0),
        DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        },
    );
    let clip = |range: DisplayRange| {
        (
            range.start.0.max(start) - start,
            range.end.0.min(end) - start,
        )
    };
    let mut runs: Vec<(usize, usize, Vec<InlineFormat>)> = Vec::new();
    for run in slice.runs.into_iter().filter(|run| !run.formats.is_empty()) {
        let (a, z) = clip(run.range);
        match runs.last_mut() {
            Some(last) if last.1 == a && last.2 == run.formats => last.1 = z,
            _ if a < z => runs.push((a, z, run.formats)),
            _ => {}
        }
    }
    Inline {
        runs,
        links: slice
            .links
            .into_iter()
            .map(|link| {
                let (a, z) = clip(link.range);
                (a, z, link.destination, link.title)
            })
            .collect(),
        wikilinks: slice
            .wikilinks
            .into_iter()
            .map(|link| {
                let (a, z) = clip(link.range);
                (a, z, link.target)
            })
            .collect(),
        atoms: slice
            .atoms
            .into_iter()
            .map(|atom| clip(atom.range))
            .collect(),
    }
}

impl EditorSession {
    /// The first row whose reparsed shape, display or (for an edited row)
    /// inline semantics differ, if any.
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
        let inlines: Vec<Option<Inline>> = rows
            .iter()
            .map(|row| {
                row.changed()
                    .then(|| inline(&self.projection, row.body.clone()))
            })
            .collect();
        let (found, used) = self.with_exact_candidate(&edit, window.clone(), |staged| {
            let projection = &staged.projection;
            let lines = projection.list_command_lines_in_source(&(0..staged.source.len_bytes()));
            // Lists the intent keeps apart must not merge.
            let mut owners: Vec<(usize, usize)> = Vec::new();
            for (index, row) in rows.iter().enumerate() {
                let (line, body) = plan.starts[index];
                let delta = plan.escapes[index].map_or(0, |(_, delta)| delta);
                let end = (body + row.body.len()).saturating_add_signed(delta) - window.start;
                let local = body - window.start..end;
                if shown(projection, local.clone()) != wanted[index]
                    || inlines[index]
                        .as_ref()
                        .is_some_and(|before| *before != inline(projection, local))
                {
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
                whole.push_str(&self.inserted_ending(rows, row));
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
    candidate.quote_depth == shape.quotes + shape.inner
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

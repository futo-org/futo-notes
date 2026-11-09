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

/// Inline semantics of each body (source ranges, ascending) from one query
/// over their whole display span.
fn inlines(projection: &crate::inline::Projection, bodies: &[Range<usize>]) -> Vec<Inline> {
    let spans: Vec<(usize, usize)> = bodies
        .iter()
        .map(|body| {
            let start = projection.display_at(body.start);
            (start, projection.display_at(body.end).max(start))
        })
        .collect();
    let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
        return Vec::new();
    };
    let slice = projection.query(
        Revision(0),
        DisplayRange {
            start: DisplayOffset(first.0),
            end: DisplayOffset(last.1),
        },
    );
    let within = |range: &DisplayRange, (start, end): (usize, usize)| {
        range.end.0 > start && (range.start.0 < end || range.start.0 == start)
    };
    // Items are in display order: each span reads only from its first overlap.
    fn from<T>(items: &[T], range: impl Fn(&T) -> &DisplayRange, start: usize) -> &[T] {
        &items[items.partition_point(|item| range(item).end.0 <= start)..]
    }
    let clip = |range: &DisplayRange, (start, end): (usize, usize)| {
        (
            range.start.0.max(start) - start,
            range.end.0.min(end) - start,
        )
    };
    spans
        .iter()
        .map(|&span| {
            let mut runs: Vec<(usize, usize, Vec<InlineFormat>)> = Vec::new();
            for run in from(&slice.runs, |run| &run.range, span.0)
                .iter()
                .take_while(|run| run.range.start.0 <= span.1)
                .filter(|run| !run.formats.is_empty() && within(&run.range, span))
            {
                let (a, z) = clip(&run.range, span);
                match runs.last_mut() {
                    Some(last) if last.1 == a && last.2 == run.formats => last.1 = z,
                    _ if a < z => runs.push((a, z, run.formats.clone())),
                    _ => {}
                }
            }
            Inline {
                runs,
                links: from(&slice.links, |link| &link.range, span.0)
                    .iter()
                    .take_while(|link| link.range.start.0 <= span.1)
                    .filter(|link| within(&link.range, span))
                    .map(|link| {
                        let (a, z) = clip(&link.range, span);
                        (a, z, link.destination.clone(), link.title.clone())
                    })
                    .collect(),
                wikilinks: from(&slice.wikilinks, |link| &link.range, span.0)
                    .iter()
                    .take_while(|link| link.range.start.0 <= span.1)
                    .filter(|link| within(&link.range, span))
                    .map(|link| {
                        let (a, z) = clip(&link.range, span);
                        (a, z, link.target.clone())
                    })
                    .collect(),
                atoms: from(&slice.atoms, |atom| &atom.range, span.0)
                    .iter()
                    .take_while(|atom| atom.range.start.0 <= span.1)
                    .filter(|atom| within(&atom.range, span))
                    .map(|atom| clip(&atom.range, span))
                    .collect(),
            }
        })
        .collect()
}

impl EditorSession {
    /// The first row whose reparsed shape, display or (for an edited row)
    /// inline semantics differ, if any. With `merge`, an intended list may
    /// continue the parsed list above it instead of staying separate.
    pub(super) fn verify_rows(
        &self,
        expected: Revision,
        window: &Range<usize>,
        rows: &[Row],
        plan: &Plan,
        work: &mut EditWork,
        merge: bool,
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
        let edited: Vec<usize> = (0..rows.len()).filter(|&at| rows[at].changed()).collect();
        let bodies: Vec<_> = edited.iter().map(|&at| rows[at].body.clone()).collect();
        let before = inlines(&self.projection, &bodies);
        let (found, used) = self.with_exact_candidate(&edit, window.clone(), |staged| {
            let projection = &staged.projection;
            let lines = projection.list_command_lines_in_source(&(0..staged.source.len_bytes()));
            // Lists the intent keeps apart must not merge.
            let mut owners: Vec<((usize, usize), usize)> = Vec::new();
            let mut candidate_bodies = Vec::with_capacity(edited.len());
            for (index, row) in rows.iter().enumerate() {
                let (line, body) = plan.starts[index];
                let delta = plan.escapes[index].map_or(0, |(_, delta)| delta);
                let end = (body + row.body.len()).saturating_add_signed(delta) - window.start;
                let local = body - window.start..end;
                if shown(projection, local.clone()) != wanted[index] {
                    return Ok(Some(index));
                }
                if row.changed() {
                    candidate_bodies.push(local);
                }
                let line = line - window.start;
                let found = lines
                    .binary_search_by_key(&line, |candidate| candidate.source.start)
                    .ok()
                    .map(|at| &lines[at]);
                let merged = found
                    .and_then(|candidate| candidate.list.as_ref())
                    .filter(|_| !merge && row.after.opens && !row.blank)
                    .is_some_and(|list| {
                        // One intended list per parsed list, both ways.
                        // Lists continuing from before a staged window all
                        // start at it, so depth tells them apart.
                        let parsed = (list.owner.start, list.depth);
                        match owners
                            .iter()
                            .find(|(owner, key)| *owner == parsed || *key == row.key)
                        {
                            Some(&(owner, key)) => owner != parsed || key != row.key,
                            None => {
                                owners.push((parsed, row.key));
                                false
                            }
                        }
                    });
                if merged || !same_row(row, line, found, merge) {
                    return Ok(Some(index));
                }
            }
            if staged.display_text() != whole {
                return Ok(Some(rows.len() - 1));
            }
            // Respelling and repairs never change an edited body's inline runs.
            let after = inlines(projection, &candidate_bodies);
            Ok(before
                .iter()
                .zip(&after)
                .position(|(before, after)| before != after)
                .map(|at| edited[at]))
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
    merge: bool,
) -> bool {
    let Some(candidate) = found else {
        return row.blank;
    };
    if row.blank {
        return merge || !row.exact_blank || candidate.list.is_none();
    }
    let shape = &row.after;
    // Markdown has no empty paragraph between items: a merged list keeps the
    // empty row as one of its blank lines.
    if merge && row.body.is_empty() && shape.depth == 0 && shape.heading == 0 {
        return candidate.quote_depth == shape.quotes + shape.inner && candidate.code == row.code;
    }
    candidate.quote_depth == shape.quotes + shape.inner
        && candidate.heading == shape.heading
        && candidate.code == row.code
        && candidate.divider == row.divider
        && match &candidate.list {
            None => shape.depth == 0,
            Some(list) => {
                let opens = list.first && list.marker.start >= line;
                // An untouched item of a merged list takes that list's
                // numbering; an edited item keeps the number it was given.
                let renumbered = merge && !row.changed() && list.owner.start < line;
                list.depth == shape.depth
                    && opens == shape.opens
                    && (!opens
                        || (renumbered || list.ordinal == shape.ordinal)
                            && list.checked == shape.checked)
            }
        }
}

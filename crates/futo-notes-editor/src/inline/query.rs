//! Read-only projection slices for a display range.

use super::*;

impl Projection {
    pub fn query(&self, revision: Revision, range: DisplayRange) -> ProjectionSlice {
        self.query_with_work(revision, range).0
    }

    pub(crate) fn query_with_work(
        &self,
        revision: Revision,
        range: DisplayRange,
    ) -> (ProjectionSlice, references::ReferenceWork) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        // Rows are read in independent runs of rows; adjacent pieces merge
        // across a seam exactly as they would have in one sweep.
        let chunks: Vec<_> = (first..=last)
            .step_by(QUERY_ROWS)
            .map(|start| start..=(start + QUERY_ROWS - 1).min(last))
            .collect();
        let parts = crate::parallel::map(&chunks, |rows| self.query_rows(rows.clone(), range));
        let mut runs: Vec<SemanticRun> = Vec::new();
        let mut correspondence: Vec<Correspondence> = Vec::new();
        let mut format_visits = 0;
        for (part_runs, part_correspondence, visits) in parts {
            format_visits += visits;
            let mut part_runs = part_runs.into_iter();
            if let Some(run) = part_runs.next() {
                push_semantic(&mut runs, run);
            }
            runs.extend(part_runs);
            let mut part_correspondence = part_correspondence.into_iter();
            if let Some(piece) = part_correspondence.next() {
                push_run(&mut correspondence, piece);
            }
            correspondence.extend(part_correspondence);
        }
        // The view reads no cross-row list ranges.
        let mut lines = self.view_block_lines(range);
        if range.start != range.end {
            // An empty line at the range's end (zero width, so outside the
            // half-open overlap test) still has a block the view draws: a list
            // item, a heading, a quote or a code line.
            for block in self.view_block_lines(DisplayRange {
                start: range.end,
                end: range.end,
            }) {
                let at = self.display_at(block.content.start);
                // A block that starts where a listed line ends is that line's
                // own continuation (a setext underline), not a line of its own.
                let styled = block.list.is_some()
                    || block.heading > 0
                    || block.quote_depth > 0
                    || block.code;
                if styled
                    && at == range.end.0
                    && self.display_at(block.content.end) == at
                    && !lines.iter().any(|line| {
                        line.content == block.content || self.display_at(line.content.end) == at
                    })
                {
                    lines.push(block);
                }
            }
        }
        let blocks = crate::parallel::map(&lines, |block| crate::BlockDescription {
            range: DisplayRange {
                start: DisplayOffset(self.display_at(block.content.start)),
                end: DisplayOffset(self.display_at(block.content.end)),
            },
            heading: block.heading,
            quote_depth: block.quote_depth,
            divider: block.divider,
            // The old engine reads no marker text; deleted at the cut-over.
            list: block.list.as_ref().map(|list| crate::ListDescription {
                indent: list.marker_column,
                marker: list
                    .ordinal
                    .map_or_else(|| "-".to_owned(), |n| format!("{n}.")),
                ordered: list.ordinal.is_some(),
                checked: list.checked,
                first: list.first,
            }),
            code: block.code,
            language: block.code_language.clone(),
            metadata: block.metadata,
        });
        let (links, mut work) = self.link_descriptions_with_work(range);
        work.items += format_visits;
        let (wikilinks, wikilink_items) = self.wikilink_descriptions(range);
        work.items += wikilink_items;
        let atoms = self.atom_descriptions(range);
        (
            ProjectionSlice {
                links,
                wikilinks,
                atoms,
                blocks,
                revision,
                range,
                text: self
                    .display
                    .byte_slice(range.start.0..range.end.0)
                    .to_string(),
                runs,
                correspondence,
            },
            work,
        )
    }
}

impl Projection {
    /// Semantic runs and correspondence of rows `rows`, clipped to `range`.
    fn query_rows(
        &self,
        rows: std::ops::RangeInclusive<usize>,
        range: DisplayRange,
    ) -> (Vec<SemanticRun>, Vec<Correspondence>, usize) {
        let mut runs: Vec<SemanticRun> = Vec::new();
        let mut correspondence: Vec<Correspondence> = Vec::new();
        let mut format_visits = 0;
        for index in rows {
            let (row, source, display) = self.rows.at(index);
            let mut sweep = super::row::FormatSweep::new(row);
            for segment in &row.segments {
                let start = display + segment.display.start;
                let end = display + segment.display.end;
                if start > range.end.0 || end < range.start.0 {
                    continue;
                }
                push_run(
                    &mut correspondence,
                    Correspondence {
                        source: SourceRange {
                            start: SourceOffset(source + segment.source.start),
                            end: SourceOffset(source + segment.source.end),
                        },
                        display: DisplayRange {
                            start: DisplayOffset(start),
                            end: DisplayOffset(end),
                        },
                        kind: if start == end {
                            CorrespondenceKind::Hidden
                        } else if segment.identity {
                            CorrespondenceKind::Literal
                        } else {
                            CorrespondenceKind::Replaced
                        },
                    },
                );
                if start == end || start >= range.end.0 || end <= range.start.0 {
                    continue;
                }
                let mut formats = sweep.formats_at(segment.source.start, &mut format_visits);
                formats.sort();
                formats.dedup();
                let selected = DisplayRange {
                    start: DisplayOffset(start.max(range.start.0)),
                    end: DisplayOffset(end.min(range.end.0)),
                };
                if let Some(previous) = runs.last_mut() {
                    if previous.range.end == selected.start && previous.formats == formats {
                        previous.range.end = selected.end;
                        continue;
                    }
                }
                runs.push(SemanticRun {
                    range: selected,
                    formats,
                });
            }
        }
        (runs, correspondence, format_visits)
    }
}

/// Rows per independently read run of a projection query.
const QUERY_ROWS: usize = 16;

/// A run continues the previous one when it starts where that ends with the
/// same formats.
fn push_semantic(runs: &mut Vec<SemanticRun>, run: SemanticRun) {
    match runs.last_mut() {
        Some(previous)
            if previous.range.end == run.range.start && previous.formats == run.formats =>
        {
            previous.range.end = run.range.end;
        }
        _ => runs.push(run),
    }
}

/// Hidden pieces at one display point, and literal stretches contiguous in
/// both coordinates, each arrive as one run.
fn push_run(runs: &mut Vec<Correspondence>, piece: Correspondence) {
    match runs.last_mut() {
        Some(previous)
            if previous.kind == piece.kind
                && piece.kind != CorrespondenceKind::Replaced
                && previous.source.end == piece.source.start
                && previous.display.end == piece.display.start =>
        {
            previous.source.end = piece.source.end;
            previous.display.end = piece.display.end;
        }
        _ => runs.push(piece),
    }
}

impl Projection {
    /// Intersection over visible segments, without materializing selected text,
    /// link descriptions or correspondence for a toolbar refresh.
    pub(crate) fn selection_formats(&self, range: DisplayRange) -> Vec<InlineFormat> {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut common: Option<Vec<InlineFormat>> = None;
        let mut visits = 0;
        for index in first..=last {
            let (row, _, display) = self.rows.at(index);
            let mut sweep = super::row::FormatSweep::new(row);
            for segment in &row.segments {
                if segment.display.start == segment.display.end
                    || display + segment.display.start >= range.end.0
                    || display + segment.display.end <= range.start.0
                {
                    continue;
                }
                let formats = sweep.formats_at(segment.source.start, &mut visits);
                match &mut common {
                    Some(common) => common.retain(|format| formats.contains(format)),
                    None => common = Some(formats),
                }
                if common.as_ref().is_some_and(Vec::is_empty) {
                    return Vec::new();
                }
            }
        }
        let mut common = common.unwrap_or_default();
        common.sort();
        common.dedup();
        common
    }
}

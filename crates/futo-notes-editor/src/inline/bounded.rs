//! Retained canonical proof for the first bounded opaque-code input slice.
use super::*;
use std::ops::Range;

pub(crate) struct RetainedCode {
    pub body: Range<usize>,
    pub display: Range<usize>,
    pub whole: Range<usize>,
    pub language: Option<String>,
}

impl Projection {
    /// Explicit entry preparation may inspect a whole retained row. Subsequent
    /// code keys use this proof, never equal source/display bytes as provenance.
    pub(crate) fn retain_bounded_code(
        &self,
        at: DisplayOffset,
        work: &mut crate::BoundedWork,
    ) -> Option<RetainedCode> {
        let (row, source, display, visits) = self.rows.display_row_with_work(at.0);
        work.metadata_items += visits;
        let ((low, high), mapped) = row.source_bounds_with_work(at.0 - display);
        work.metadata_items += mapped;
        for endpoint in [low, high] {
            let index = row
                .blocks
                .partition_point(|block| {
                    work.metadata_items += 1;
                    block.source.start <= endpoint
                })
                .saturating_sub(1);
            work.metadata_items += 1;
            let block = row.blocks.get(index)?;
            let Some(fence) = &block.fence else { continue };
            if block.quote_depth != 0 || block.in_list || block.list.is_some() {
                continue;
            }
            let opener_index = row
                .blocks
                .partition_point(|line| {
                    work.metadata_items += 1;
                    line.source.start <= fence.opener.start
                })
                .saturating_sub(1);
            work.metadata_items += 1;
            let opener = row.blocks.get(opener_index)?;
            if opener.source.start != fence.opener.start
                || fence.body.is_empty()
                || fence.closer.is_none()
            {
                continue;
            }
            let start = row.display_at_with_work(fence.body.start);
            let end = row.display_at_with_work(fence.body.end);
            work.metadata_items += start.1 + end.1;
            if at.0 < display + start.0 || display + end.0 < at.0 {
                continue;
            }
            // A large copied language would itself defeat a local result bound.
            if block
                .code_language
                .as_ref()
                .is_some_and(|language| language.len() > 256)
            {
                return None;
            }
            let mut covered_source = fence.body.start;
            let mut covered_display = start.0;
            let first = row.segments.partition_point(|segment| {
                work.metadata_items += 1;
                segment.source.end <= fence.body.start
            });
            for segment in &row.segments[first..] {
                work.metadata_items += 1;
                if segment.source.start >= fence.body.end {
                    break;
                }
                let begin = segment.source.start.max(fence.body.start);
                let finish = segment.source.end.min(fence.body.end);
                if begin >= finish {
                    continue;
                }
                if !segment.identity
                    || begin != covered_source
                    || segment.display.start + begin - segment.source.start != covered_display
                {
                    return None;
                }
                covered_source = finish;
                covered_display += finish - begin;
            }
            if covered_source != fence.body.end || covered_display != end.0 {
                return None;
            }
            work.copied_bytes += block.code_language.as_ref().map_or(0, String::len);
            return Some(RetainedCode {
                body: source + fence.body.start..source + fence.body.end,
                display: display + start.0..display + end.0,
                whole: source + fence.whole.start..source + fence.whole.end,
                language: block.code_language.clone(),
            });
        }
        None
    }
}

mod certificates;
pub(crate) use certificates::{FenceSuffix, ParagraphUnit, PlainPrefix};

impl Projection {
    /// Explicit full-mode refresh of a certified suffix. Prefix rows and their
    /// transient provenance remain owned and unchanged. Never a bounded step.
    pub(crate) fn refresh_bounded_suffix(
        &mut self,
        source: &Rope,
        at: usize,
    ) -> crate::BoundedWork {
        let first = self.rows.locate(at, false);
        let (_, begin, display) = self.rows.at(first);
        assert_eq!(begin, at, "certified fence begins its canonical row");
        let raw = source.byte_slice(begin..source.len_bytes()).to_string();
        let parsed: Vec<_> = partition(&raw, super::Outside::default())
            .rows
            .into_iter()
            .map(|piece| {
                let shape = (piece.continues, piece.through, piece.opener.as_deref());
                Row::piece(piece.text, shape, &self.references, &[])
            })
            .collect();
        let text: String = parsed.iter().map(|row| row.display.as_str()).collect();
        let mut work = crate::BoundedWork {
            inspected_source_bytes: raw.len(),
            copied_bytes: raw.len() + text.len(),
            parsed_source_bytes: raw.len()
                + parsed
                    .iter()
                    .map(|row| row.parsed_source_bytes)
                    .sum::<usize>(),
            ..Default::default()
        };
        for row in &parsed {
            work.metadata_items += row.reference_work.items;
            work.copied_bytes += row.reference_work.copied;
        }
        let start = self.display.byte_to_char(display);
        self.display.remove(start..self.display.len_chars());
        self.display.insert(start, &text);
        self.rows.replace(first, self.rows.len(), parsed);
        work
    }
}

impl Projection {
    /// Seek only this retained source footprint, even when its owning fence row
    /// is giant. Marker/atom provenance is copied from canonical Segments.
    pub(crate) fn bounded_retained_meaning(
        &self,
        source: Range<usize>,
        display: Range<usize>,
        source_origin: usize,
        display_origin: usize,
        code_owner: usize,
    ) -> (crate::BoundedMeaning, crate::BoundedWork) {
        use crate::{BoundedBlock, BoundedMap, BoundedMapKind, BoundedMeaning};
        let (row, base, shown, visits) = self.rows.source_row_with_work(source.start);
        let mut work = crate::BoundedWork {
            metadata_items: visits,
            ..Default::default()
        };
        let mut mapping: Vec<BoundedMap> = Vec::new();
        let mut runs: Vec<SemanticRun> = Vec::new();
        let first = row.segments.partition_point(|segment| {
            work.metadata_items += 1;
            base + segment.source.end <= source.start
        });
        let map_display = |offset: usize| display_origin + offset - display.start;
        let map_source = |offset: usize| source_origin + offset - source.start;
        for segment in &row.segments[first..] {
            work.metadata_items += 1;
            if base + segment.source.start >= source.end {
                break;
            }
            let a = shown + segment.display.start;
            let z = shown + segment.display.end;
            let kind = if a == z {
                BoundedMapKind::Hidden
            } else if segment.identity {
                BoundedMapKind::Literal
            } else {
                BoundedMapKind::Atom
            };
            let mapped = BoundedMap {
                source: SourceRange {
                    start: SourceOffset(map_source(base + segment.source.start)),
                    end: SourceOffset(map_source(base + segment.source.end)),
                },
                display: DisplayRange {
                    start: DisplayOffset(map_display(a)),
                    end: DisplayOffset(map_display(z)),
                },
                kind,
            };
            if let Some(previous) = mapping.last_mut().filter(|previous| {
                previous.kind == kind
                    && kind != BoundedMapKind::Atom
                    && previous.source.end == mapped.source.start
                    && previous.display.end == mapped.display.start
                    && (kind != BoundedMapKind::Hidden || previous.display == mapped.display)
            }) {
                previous.source.end = mapped.source.end;
                previous.display.end = mapped.display.end;
            } else {
                mapping.push(mapped);
            }
            if a == z {
                continue;
            }
            work.metadata_items += row.spans.len();
            let mut formats = row.formats_at(segment.source.start);
            formats.sort();
            formats.dedup();
            let range = DisplayRange {
                start: DisplayOffset(map_display(a)),
                end: DisplayOffset(map_display(z)),
            };
            if let Some(previous) = runs
                .last_mut()
                .filter(|previous| previous.formats == formats && previous.range.end == range.start)
            {
                previous.range.end = range.end;
            } else {
                runs.push(SemanticRun { range, formats });
            }
        }
        let mut blocks = Vec::new();
        let first = row.blocks.partition_point(|block| {
            work.metadata_items += 1;
            base + block.source.end <= source.start
        });
        for block in &row.blocks[first..] {
            work.metadata_items += 1;
            if base + block.source.start >= source.end {
                break;
            }
            let (a, va) = row.display_at_with_work(block.content.start);
            let (z, vz) = row.display_at_with_work(block.content.end);
            work.metadata_items += va + vz;
            let a = shown + a;
            let z = shown + z;
            let clipped_a = a.max(display.start).min(display.end);
            let clipped_z = z.max(display.start).min(display.end);
            let language = block.code_language.clone();
            work.copied_bytes += language.as_ref().map_or(0, String::len);
            blocks.push(BoundedBlock {
                description: crate::BlockDescription {
                    range: DisplayRange {
                        start: DisplayOffset(map_display(clipped_a)),
                        end: DisplayOffset(map_display(clipped_z)),
                    },
                    heading: block.heading,
                    quote_depth: block.quote_depth,
                    divider: block.divider,
                    list: None,
                    code: block.code,
                    language,
                    metadata: false,
                },
                source_owner: block.code.then_some(SourceOffset(code_owner)),
                continues_before: a < display.start,
                continues_after: z > display.end,
            });
        }
        let mut links = Vec::new();
        for span in &row.spans {
            work.metadata_items += 1;
            let row::SpanKind::Link(meaning) = &span.kind else {
                continue;
            };
            let (a, va) = row.display_at_with_work(span.open.end);
            let (z, vz) = row.display_at_with_work(span.close.start);
            work.metadata_items += va + vz;
            work.copied_bytes +=
                meaning.destination.len() + meaning.title.as_ref().map_or(0, String::len);
            links.push(crate::LinkDescription {
                range: DisplayRange {
                    start: DisplayOffset(map_display(shown + a)),
                    end: DisplayOffset(map_display(shown + z)),
                },
                destination: meaning.destination.clone(),
                title: meaning.title.clone(),
            });
        }
        let text = self.display.byte_slice(display.clone()).to_string();
        work.copied_bytes += text.len();
        work.returned_text_bytes = text.len();
        work.returned_records = mapping.len() + runs.len() + blocks.len() + links.len();
        (
            BoundedMeaning {
                range: DisplayRange {
                    start: DisplayOffset(display_origin),
                    end: DisplayOffset(display_origin + text.len()),
                },
                text,
                mapping,
                runs,
                blocks,
                links,
            },
            work,
        )
    }
}

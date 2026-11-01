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
        let mut runs: Vec<SemanticRun> = Vec::new();
        let mut correspondence: Vec<Correspondence> = Vec::new();
        for index in first..=last {
            let (row, source, display) = self.rows.at(index);
            for segment in &row.segments {
                let start = display + segment.display.start;
                let end = display + segment.display.end;
                if start > range.end.0 || end < range.start.0 {
                    continue;
                }
                let mapped = Correspondence {
                    source: SourceRange {
                        start: SourceOffset(source + segment.source.start),
                        end: SourceOffset(source + segment.source.end),
                    },
                    display: DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                };
                if let Some(previous) = correspondence.last_mut() {
                    if previous.display.start == previous.display.end
                        && mapped.display == previous.display
                        && previous.source.end == mapped.source.start
                    {
                        previous.source.end = mapped.source.end;
                    } else {
                        correspondence.push(mapped);
                    }
                } else {
                    correspondence.push(mapped);
                }
                if start == end || start >= range.end.0 || end <= range.start.0 {
                    continue;
                }
                let mut formats = row.formats_at(segment.source.start);
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
        let blocks = self
            .block_lines(range)
            .into_iter()
            .map(|block| crate::BlockDescription {
                range: DisplayRange {
                    start: DisplayOffset(self.display_at(block.content.start)),
                    end: DisplayOffset(self.display_at(block.content.end)),
                },
                heading: block.heading,
                quote_depth: block.quote_depth,
                divider: block.divider,
                list: block.list.as_ref().map(|list| crate::ListDescription {
                    depth: list.depth,
                    number: list.ordinal,
                    checked: list.checked,
                    first: list.first,
                }),
                code: block.code,
                language: block.code_language,
                metadata: block.metadata,
            })
            .collect();
        let (links, mut work) = self.link_descriptions_with_work(range);
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

mod block_edit;
pub(crate) use block_edit::BodySource;
mod block_queries;
pub(crate) mod blocks;
mod blocks_paragraph;
mod edit;
pub(crate) use edit::{EditIntent, Plan, SourceCorrespondence};
mod empty_comments;
pub(crate) mod fences;
pub(crate) mod guarded_words;
mod links;
pub(crate) use links::complete_bare_uri;
mod lists;
mod pending_links;
pub(crate) mod references;
pub(crate) mod typed_angle;
pub(crate) use pending_links::{PendingLinkWitness, PendingLinks};
#[cfg(test)]
pub(crate) mod coordinate_work_tests;
#[cfg(test)]
mod query_growth_tests;
mod retained_points;
mod row;
mod source_points;
mod spelling;
pub(crate) use spelling::relink::{RetainedFormat, RetiredLinkText};
mod toggle;
mod tree;

use crate::{
    Correspondence, DisplayOffset, DisplayRange, InlineFormat, ProjectionSlice, Revision,
    SemanticRun, SourceEdit, SourceOffset, SourceRange,
};
pub(crate) use lists::{columns, visit_container, visit_correspondence, ListLine};
#[cfg(test)]
pub(crate) use lists::{
    CONTAINER_BLOCK_QUERY_VISITS, CONTAINER_CORRESPONDENCE_SCANS, CONTAINER_LIFT_ITEM_SCANS,
    CONTAINER_METADATA_VISITS, CONTAINER_PREFIX_QUERIES, CONTAINER_STYLE_OWNER_SCANS,
};
use ropey::Rope;
use row::{paragraphs, Row};
pub(crate) use tree::ContextWitness;
use tree::Rows;
#[cfg(test)]
pub(crate) use tree::CONTEXT_VISITS;

pub(crate) struct Projection {
    pub display: Rope,
    pub rows: Rows,
    pub initial_parse_work: usize,
    pub references: std::sync::Arc<references::References>,
    pub(crate) references_complete: bool,
    pub(crate) needs_global_references: bool,
    /// Set only by the canonical actual-meaning-change rebuild owner. A fresh
    /// bounded preview can use this result to project its physical prefix.
    pub(crate) has_rebuilt_references: bool,
    pub initial_link_metadata_items: usize,
    pub initial_link_copied_bytes: usize,
}

pub(crate) struct Update {
    pub range: DisplayRange,
    pub inserted: String,
    pub parsed_source_bytes: usize,
    pub materialized_source_bytes: usize,
    pub semantic_range: DisplayRange,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}

impl Projection {
    pub fn new(source: &str) -> Self {
        let (references, winners, reference_work) = references::References::scan(source);
        let mut projection = Self::with_references(source, references, &winners, reference_work);
        projection.references_complete = true;
        projection
    }

    pub(crate) fn with_references(
        source: &str,
        references: std::sync::Arc<references::References>,
        winners: &[references::Winner],
        reference_work: references::ReferenceWork,
    ) -> Self {
        let mut origin = 0;
        let mut witness_work = 0;
        let parsed: Vec<_> = paragraphs(source)
            .into_iter()
            .map(|text| {
                let (local, work) = references::window_winners(winners, origin, text.len());
                witness_work += work;
                let row = Row::parse_with_references(text, &references, &local);
                origin += text.len();
                row
            })
            .collect();
        let initial_link_metadata_items = reference_work.items
            + witness_work
            + parsed
                .iter()
                .map(|row| row.reference_work.items)
                .sum::<usize>();
        let initial_link_copied_bytes = reference_work.copied
            + parsed
                .iter()
                .map(|row| row.reference_work.copied)
                .sum::<usize>();
        let initial_parse_work = reference_work.parsed
            + source.len()
            + parsed
                .iter()
                .map(|row| row.parsed_source_bytes)
                .sum::<usize>();
        let mut display = Rope::new();
        for row in &parsed {
            display.append(Rope::from_str(&row.display));
        }
        let mut rows = Rows::default();
        rows.replace(0, 0, parsed);
        Self {
            display,
            rows,
            initial_parse_work,
            initial_link_metadata_items,
            initial_link_copied_bytes,
            references,
            references_complete: false,
            needs_global_references: false,
            has_rebuilt_references: false,
        }
    }

    /// Whole paragraph context for an explicit compound action. Ordinary typing
    /// never constructs this temporary session or materializes this envelope.
    pub fn edit_window(&self, range: DisplayRange) -> (std::ops::Range<usize>, usize) {
        let first = self.rows.locate(range.start.0, true).saturating_sub(1);
        let last = (self.rows.locate(range.end.0, true) + 1).min(self.rows.len() - 1);
        let (_, source_start, display_start) = self.rows.at(first);
        let (row, source_end, _) = self.rows.at(last);
        (source_start..source_end + row.source_len, display_start)
    }

    pub fn source_bounds(&self, offset: usize) -> (usize, usize) {
        let (row, source, display) = self.rows.at(self.rows.locate(offset, true));
        let (low, high) = row.source_bounds(offset - display);
        (source + low, source + high)
    }

    pub fn formats_at(&self, offset: usize) -> Vec<InlineFormat> {
        let (row, source, _) = self.rows.at(self.rows.locate(offset, false));
        row.formats_at(offset - source)
    }

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
            })
            .collect();
        let (links, work) = self.link_descriptions_with_work(range);
        (
            ProjectionSlice {
                links,
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

    /// Reparse the edit's paragraphs and immediate neighbors, which can join
    /// when a blank-line separator changes. No tail offsets are rewritten.
    pub fn apply(
        &mut self,
        source: &Rope,
        edit: &SourceEdit,
        canonical_origin: Option<&references::SourceOrigin>,
    ) -> Update {
        let first = self
            .rows
            .locate(edit.range.start.0, false)
            .saturating_sub(1);
        let last = (self.rows.locate(edit.range.end.0, false) + 1).min(self.rows.len() - 1);
        let (pending, metadata_work) = self.pending_display(first, last);
        let (delimiters, delimiter_work) = self.retained_delimiters(first, last, edit);
        let mut guards = Vec::new();
        let mut typed_inputs = Vec::new();
        let (_, source_start, display_start) = self.rows.at(first);
        let (row, old_end, display_end) = self.rows.at(last);
        let source_end = old_end + row.source_len - edit.removed.len() + edit.inserted.len();
        let display_end = display_end + row.display.len();
        let text = source.byte_slice(source_start..source_end).to_string();
        #[cfg(test)]
        materialization_tests::allocated(materialization_tests::Buffer::Apply, text.len());
        let mut winners = Vec::new();
        let mut reference_work = references::ReferenceWork::default();
        for index in first..=last {
            let (row, base, _) = self.rows.at(index);
            pending_links::retain_row_fields(
                row,
                base,
                edit,
                &mut guards,
                &mut typed_inputs,
                &mut reference_work.items,
            );
            for definition in row
                .definitions
                .iter()
                .filter(|definition| definition.winner)
            {
                let mut range = base + definition.range.start..base + definition.range.end;
                if edit.range.end.0 <= range.start {
                    range.start = range.start - edit.removed.len() + edit.inserted.len();
                    range.end = range.end - edit.removed.len() + edit.inserted.len();
                } else if edit.range.start.0 < range.end && range.start < edit.range.end.0 {
                    continue;
                }
                if let Some(target) = self.references.target(definition.key.as_ref()) {
                    winners.push(references::Winner {
                        range: range.start - source_start..range.end - source_start,
                        key: target.reference.as_ref().unwrap().clone(),
                    });
                }
            }
        }
        let mut origin = 0;
        let parsed: Vec<_> = paragraphs(&text)
            .into_iter()
            .map(|raw| {
                let (local, work) = references::window_winners(&winners, origin, raw.len());
                reference_work.items += work;
                let row = Row::parse_with_references(raw, &self.references, &local);
                origin += raw.len();
                row
            })
            .collect();
        #[cfg(test)]
        let comparison_visits = coordinate_work_tests::visits();
        let (meaning_changed, comparison_work) =
            self.reference_meaning_changed(first, last, source_start, &parsed, edit);
        #[cfg(test)]
        coordinate_work_tests::query("reference-comparison", comparison_visits, comparison_work);
        reference_work.items += comparison_work;
        if meaning_changed {
            if self.references_complete || canonical_origin.is_some() {
                let local_parsed = text.len()
                    + parsed
                        .iter()
                        .map(|row| row.parsed_source_bytes)
                        .sum::<usize>();
                let local_items = reference_work.items
                    + parsed
                        .iter()
                        .map(|row| row.reference_work.items)
                        .sum::<usize>();
                let local_copied = reference_work.copied
                    + parsed
                        .iter()
                        .map(|row| row.reference_work.copied)
                        .sum::<usize>();
                #[cfg(test)]
                coordinate_work_tests::child(
                    "semantic-delimiters",
                    crate::EditWork {
                        link_metadata_items: delimiter_work,
                        ..Default::default()
                    },
                );
                return self.rebuild_references(
                    source,
                    edit,
                    text.len(),
                    local_parsed,
                    local_items + metadata_work,
                    local_copied,
                    canonical_origin,
                );
            }
            self.needs_global_references = true;
        }
        let link_copied_bytes = reference_work.copied
            + parsed
                .iter()
                .map(|row| row.reference_work.copied)
                .sum::<usize>();
        let mut reference_items = reference_work.items
            + parsed
                .iter()
                .map(|row| row.reference_work.items)
                .sum::<usize>();
        let parsed_source_bytes = text.len()
            + parsed
                .iter()
                .map(|row| row.parsed_source_bytes)
                .sum::<usize>();
        let mut inserted = String::new();
        for row in &parsed {
            inserted.push_str(&row.display);
        }
        let parsed_display_len = inserted.len();
        let old = self
            .display
            .byte_slice(display_start..display_end)
            .to_string();
        let start = self.display.byte_to_char(display_start);
        let end = self.display.byte_to_char(display_end);
        self.display.remove(start..end);
        self.display.insert(start, &inserted);
        self.rows.replace(first, last + 1, parsed);
        if !guards.is_empty() || !typed_inputs.is_empty() {
            let retained = PendingLinks {
                window: source_start..source_end,
                ranges: Vec::new(),
                delimiters: Vec::new(),
                guarded_words: guards,
                typed_inputs,
                work: 0,
            };
            reference_items +=
                self.restore_guard_words(&retained) + self.restore_typed_origins(&retained);
        }
        let prefix: usize = old
            .chars()
            .zip(inserted.chars())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let suffix: usize = old[prefix..]
            .chars()
            .rev()
            .zip(inserted[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let range = DisplayRange {
            start: DisplayOffset(display_start + prefix),
            end: DisplayOffset(display_end - suffix),
        };
        let inserted = inserted[prefix..inserted.len() - suffix].to_owned();
        let semantic_range = DisplayRange {
            start: DisplayOffset(display_start),
            end: DisplayOffset(display_start + parsed_display_len),
        };
        let link_metadata_items = reference_items
            + metadata_work
            + delimiter_work
            + self.install_delimiters(delimiters)
            + self.preserve_pending_display(pending, range, inserted.len());
        Update {
            link_copied_bytes,
            link_metadata_items,
            range,
            inserted,
            parsed_source_bytes,
            materialized_source_bytes: text.len(),
            semantic_range,
        }
    }
}

#[cfg(test)]
mod materialization_tests;

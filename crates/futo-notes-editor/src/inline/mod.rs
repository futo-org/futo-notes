mod block_edit;
pub(crate) use block_edit::BodySource;
mod block_queries;
pub(crate) mod blocks;
mod blocks_paragraph;
mod edit;
pub(crate) use edit::{EditIntent, Plan, SourceCorrespondence};
pub(crate) mod fences;
mod find;
pub(crate) mod front_matter;
pub(crate) mod guarded_words;
mod links;
mod lists;
mod pending_links;
mod query;
pub(crate) mod references;
pub(crate) mod typed_angle;
pub(crate) use pending_links::{PendingLinkWitness, PendingLinks};
#[cfg(test)]
mod cross_feature_tests;
pub(crate) mod images;
mod row;
pub(crate) use row::parser_options;
mod source_points;
mod spelling;
pub(crate) use spelling::EscapeTypedDelimiters;
#[cfg(test)]
mod split_nested_tests;
#[cfg(test)]
mod split_tests;
#[cfg(test)]
mod table_split_tests;
mod toggle;
mod tree;
mod window;
use window::Window;
pub(crate) mod wikilinks;

use crate::{
    Correspondence, CorrespondenceKind, DisplayOffset, DisplayRange, InlineFormat, ProjectionSlice,
    Revision, SemanticRun, SourceEdit, SourceOffset, SourceRange,
};
pub(crate) use lists::{columns, ListLine};
use ropey::Rope;
use row::{partition, Outside, Row};
use tree::Rows;

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
    /// Note ids delivered by the store; never part of source or history.
    pub(crate) catalog: std::sync::Arc<futo_notes_wikilinks::WikilinkIndex>,
    /// Whether source offset zero is the note's start (front matter owner).
    pub(crate) document_start: bool,
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
        let mut projection =
            Self::with_references(source, true, references, &winners, reference_work);
        projection.references_complete = true;
        projection
    }

    /// `document_start` says whether `source` begins the note, which alone can
    /// hold front matter.
    pub(crate) fn with_references(
        source: &str,
        document_start: bool,
        references: std::sync::Arc<references::References>,
        winners: &[references::Winner],
        reference_work: references::ReferenceWork,
    ) -> Self {
        Self::in_context(
            source,
            document_start,
            references,
            winners,
            reference_work,
            None,
        )
    }

    /// A projection of `source` whose first row continues a nested list
    /// after `context` (its ancestors' lines) with its first item numbered
    /// as given, as a staged window starting at such a row is.
    pub(crate) fn in_context(
        source: &str,
        document_start: bool,
        references: std::sync::Arc<references::References>,
        winners: &[references::Winner],
        reference_work: references::ReferenceWork,
        context: Option<(&str, Option<u64>)>,
    ) -> Self {
        let outside = match context {
            Some((context, first_number)) => Outside {
                continues: true,
                context: Some(context),
                first_number,
                ..Outside::default()
            },
            None => Outside::default(),
        };
        let metadata = if document_start {
            front_matter::len(source.bytes())
        } else {
            0
        };
        let mut origin = metadata;
        let mut witness_work = 0;
        let parsed: Vec<_> = (metadata > 0)
            .then(|| Row::metadata(&source[..metadata]))
            .into_iter()
            .chain(
                partition(&source[metadata..], outside)
                    .rows
                    .into_iter()
                    .map(|piece| {
                        let text = piece.text;
                        let (local, work) = references::window_winners(winners, origin, text.len());
                        witness_work += work;
                        let row = Row::piece(text, &piece.shape, &references, &local);
                        origin += text.len();
                        row
                    }),
            )
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
            catalog: Default::default(),
            document_start,
        }
    }

    /// Whole paragraph context for an explicit compound action. Ordinary typing
    /// never constructs this temporary session or materializes this envelope.
    pub fn edit_window(&self, range: DisplayRange) -> (std::ops::Range<usize>, usize) {
        self.edit_window_with(range, true)
    }

    /// `whole_ordered` holds a whole cut ordered list for numbering commands;
    /// a local list edit reads only its neighbors (cut rows number alike).
    pub fn edit_window_with(
        &self,
        range: DisplayRange,
        whole_ordered: bool,
    ) -> (std::ops::Range<usize>, usize) {
        let mut first = self.rows.locate(range.start.0, true).saturating_sub(1);
        let mut last = (self.rows.locate(range.end.0, true) + 1).min(self.rows.len() - 1);
        // A staged window is opened alone, so it starts at the opener line of
        // a cut raw HTML block it enters, and holds a whole cut ordered list,
        // whose numbering commands renumber every item: a one-off
        // region-sized read (#314).
        let ordered =
            |index: usize| whole_ordered && self.rows.at(index).0.first_number().is_some();
        while first > 0 && (self.rows.at(first).0.opener.is_some() || ordered(first)) {
            first = self.rows.block_start(first);
        }
        // A row inside a nested list parses only after its ancestors, and a
        // list command reads the whole nested list, as an uncut row holds it.
        let nested = (first..=(last + 1).min(self.rows.len() - 1))
            .any(|index| self.rows.at(index).0.context.is_some());
        if nested {
            while first > 0 && self.rows.at(first).0.continues {
                first = self.rows.block_start(first);
            }
            while last + 1 < self.rows.len() && self.rows.at(last + 1).0.continues {
                last = self.rows.block_end(last + 1);
            }
        }
        while last + 1 < self.rows.len() && ordered(last + 1) {
            last = self.rows.block_end(last + 1);
        }
        // Lists continue across blank lines: reach the nearest nonblank row.
        let blank = |index: usize| {
            let row = self.rows.at(index).0;
            !row.blocks.iter().any(|block| block.code) && row.display.trim().is_empty()
        };
        while last + 1 < self.rows.len() && blank(last) {
            last += 1;
        }
        while first > 0 && blank(first) {
            first -= 1;
        }
        // A staged window never ends at a word seam: one reaching a paragraph
        // cut at word seams holds that whole paragraph and a neighbor row on
        // each side, as its uncut row would (#314).
        let seamed = (first..=last).any(|index| {
            self.rows.at(index).0.mid_line
                || index + 1 < self.rows.len() && self.rows.at(index + 1).0.mid_line
        });
        if seamed {
            while first > 0 && self.rows.at(first).0.continues {
                first -= 1;
            }
            first = first.saturating_sub(1);
            while last + 1 < self.rows.len() && self.rows.at(last + 1).0.continues {
                last += 1;
            }
            last = (last + 1).min(self.rows.len() - 1);
            // The neighbor rows themselves end at whole lines.
            while first > 0 && self.rows.at(first).0.mid_line {
                first -= 1;
            }
            while last + 1 < self.rows.len() && self.rows.at(last + 1).0.mid_line {
                last += 1;
            }
        }
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

    /// Reparse the edit's paragraphs and immediate neighbors, which can join
    /// when a blank-line separator changes. No tail offsets are rewritten.
    pub fn apply(
        &mut self,
        source: &Rope,
        edit: &SourceEdit,
        canonical_origin: Option<&references::SourceOrigin>,
    ) -> Update {
        let Window {
            first,
            last,
            source_start,
            display_start,
            source_end,
            display_end,
            text,
            metadata,
            pieces,
            partition_bytes,
        } = self.reparse_window(source, edit);
        let (pending, metadata_work) = self.pending_display(first, last);
        let (delimiters, delimiter_work) = self.retained_delimiters(first, last, edit);
        let mut guards = Vec::new();
        let mut typed_inputs = Vec::new();
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
        let mut origin = metadata;
        let placed: Vec<_> = pieces
            .into_iter()
            .map(|(len, shape)| {
                origin += len;
                (origin - len, len, shape)
            })
            .collect();
        // Each row parses alone; a whole-note reparse spreads them over cores.
        let references = &self.references;
        let pieces = crate::parallel::map(&placed, |(origin, len, shape)| {
            let raw = &text[*origin..*origin + *len];
            let (local, work) = references::window_winners(&winners, *origin, raw.len());
            (Row::piece(raw, shape, references, &local), work)
        });
        let parsed: Vec<_> = (metadata > 0)
            .then(|| Row::metadata(&text[..metadata]))
            .into_iter()
            .chain(pieces.into_iter().map(|(row, work)| {
                reference_work.items += work;
                row
            }))
            .collect();
        let (meaning_changed, comparison_work) =
            self.reference_meaning_changed(first, last, source_start, &parsed, edit);
        reference_work.items += comparison_work;
        if meaning_changed {
            if self.references_complete || canonical_origin.is_some() {
                let local_parsed = partition_bytes
                    + text.len()
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
                return self.rebuild_references(
                    source,
                    edit,
                    partition_bytes + text.len(),
                    local_parsed,
                    local_items + metadata_work + delimiter_work,
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
        let parsed_source_bytes = partition_bytes
            + text.len()
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
            materialized_source_bytes: partition_bytes + text.len(),
            semantic_range,
        }
    }
}

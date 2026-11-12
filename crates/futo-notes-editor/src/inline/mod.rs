mod block_edit;
pub(crate) use block_edit::BodySource;
mod block_queries;
pub(crate) mod blocks;
mod blocks_paragraph;
mod edit;
#[cfg(test)]
pub(crate) use edit::last_repaired;
pub(crate) use edit::{EditIntent, EngineWritten, Plan, Repair, SourceCorrespondence};
mod kept;
pub(crate) use kept::{keeps_blocks, Expected};
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
mod word;

pub(crate) mod wikilinks;

use crate::{
    Correspondence, CorrespondenceKind, DisplayOffset, DisplayRange, InlineFormat, ProjectionSlice,
    Revision, SemanticRun, SourceEdit, SourceOffset, SourceRange,
};
pub(crate) use lists::{columns, ListLine};
use ropey::Rope;
use row::{partition, Outside};
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
        let _ = (winners, context);
        let mut carry = if document_start {
            crate::lines::Carry::start()
        } else {
            crate::lines::Carry::default()
        };
        let parsed = row::read::read_rows(source, &mut carry, document_start);
        let initial_link_metadata_items = reference_work.items;
        let initial_link_copied_bytes = reference_work.copied;
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

    /// Re-read from the row above the edit until a row after it starts with
    /// the carry it had before. No tail offsets are rewritten.
    pub fn apply(
        &mut self,
        source: &Rope,
        edit: &SourceEdit,
        _canonical_origin: Option<&references::SourceOrigin>,
    ) -> Update {
        let start = edit.range.start.0;
        let (removed, inserted) = (edit.removed.len(), edit.inserted.len());
        let (old_end, new_end) = (start + removed, start + inserted);
        let moved = |offset: usize| offset + inserted - removed;
        let total = source.len_bytes();
        let first = self.rows.locate(start, false).saturating_sub(1);
        let (first_row, source_start, display_start) = self.rows.at(first);
        let mut carry = first_row.carry.clone();
        let mut at = source_start;
        let mut old = first + 1;
        let mut parsed = Vec::new();
        let mut parsed_source_bytes = 0;
        loop {
            let chunk = next_chunk(source, at, &carry);
            parsed_source_bytes += chunk.len();
            let end = at + chunk.len();
            parsed.extend(row::read::read_rows(&chunk, &mut carry, end == total));
            at = end;
            if at >= total {
                old = self.rows.len();
                break;
            }
            if at < new_end {
                continue;
            }
            while old < self.rows.len() {
                let old_start = self.rows.at(old).1;
                if old_start < old_end || moved(old_start) < at {
                    old += 1;
                } else {
                    break;
                }
            }
            if old < self.rows.len() {
                let (row, old_start, _) = self.rows.at(old);
                if moved(old_start) == at && row.carry == carry {
                    break;
                }
            }
        }
        let last = old - 1;
        let display_end = if old < self.rows.len() {
            self.rows.at(old).2
        } else {
            self.display.len_bytes()
        };
        let (pending, metadata_work) = self.pending_display(first, last);
        let (delimiters, delimiter_work) = self.retained_delimiters(first, last, edit);
        let mut guards = Vec::new();
        let mut typed_inputs = Vec::new();
        let mut reference_items = 0;
        for index in first..=last {
            let (row, base, _) = self.rows.at(index);
            pending_links::retain_row_fields(
                row,
                base,
                edit,
                &mut guards,
                &mut typed_inputs,
                &mut reference_items,
            );
        }
        let mut inserted_text = String::new();
        for row in &parsed {
            inserted_text.push_str(&row.display);
        }
        let parsed_display_len = inserted_text.len();
        let old_display = self
            .display
            .byte_slice(display_start..display_end)
            .to_string();
        let from = self.display.byte_to_char(display_start);
        let to = self.display.byte_to_char(display_end);
        self.display.remove(from..to);
        self.display.insert(from, &inserted_text);
        self.rows.replace(first, old, parsed);
        if !guards.is_empty() || !typed_inputs.is_empty() {
            let retained = PendingLinks {
                window: source_start..at,
                ranges: Vec::new(),
                delimiters: Vec::new(),
                guarded_words: guards,
                typed_inputs,
                work: 0,
            };
            reference_items +=
                self.restore_guard_words(&retained) + self.restore_typed_origins(&retained);
        }
        let prefix: usize = old_display
            .chars()
            .zip(inserted_text.chars())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let suffix: usize = old_display[prefix..]
            .chars()
            .rev()
            .zip(inserted_text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let range = DisplayRange {
            start: DisplayOffset(display_start + prefix),
            end: DisplayOffset(display_end - suffix),
        };
        let inserted = inserted_text[prefix..inserted_text.len() - suffix].to_owned();
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
            link_copied_bytes: 0,
            link_metadata_items,
            range,
            inserted,
            parsed_source_bytes,
            materialized_source_bytes: parsed_source_bytes,
            semantic_range,
        }
    }
}

/// The source of the next row from `at`: one line, or the whole front matter
/// when the note's first line opens it.
fn next_chunk(source: &Rope, at: usize, carry: &crate::lines::Carry) -> String {
    let line_end = |from: usize| {
        let line = source.byte_to_line(from);
        if line + 1 < source.len_lines() {
            source.line_to_byte(line + 1)
        } else {
            source.len_bytes()
        }
    };
    let mut end = line_end(at);
    let first = source.byte_slice(at..end).to_string();
    if carry.first && first.trim_end_matches(['\r', '\n']) == "---" {
        while end < source.len_bytes() {
            let next = line_end(end);
            let line = source.byte_slice(end..next).to_string();
            end = next;
            if line.trim_end_matches(['\r', '\n']) == "---" {
                break;
            }
        }
        return source.byte_slice(at..end).to_string();
    }
    first
}

//! Wikilink roles over the canonical `find_wikilinks` grammar. Rows keep only
//! syntax; resolution and labels come from the projection's note-id index at
//! query time, so a note-id delivery never reparses source.
use super::row::{Row, Segment};
use futo_notes_wikilinks::{note_id_leaf, WikilinkIndex};
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(crate) struct RowWikilink {
    pub source: Range<usize>,
    pub target: Arc<str>,
}

/// One bit per leaf hash. A note-id change can affect a link only when the
/// changed id and the link target share their last component.
pub(crate) fn leaf_bit(target: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    note_id_leaf(target).hash(&mut hasher);
    1 << (hasher.finish() % 64)
}

/// Occurrences outside code and HTML whose four brackets are visible literal
/// text; an escaped or link-owned bracket is not wikilink syntax.
pub(crate) fn scan(
    source: &str,
    isolated: &[Range<usize>],
    segments: &[Segment],
) -> (Vec<RowWikilink>, u64) {
    if !source.contains("[[") {
        return (Vec::new(), 0);
    }
    let literal = |at: usize| {
        let index = segments.partition_point(|segment| segment.source.end <= at);
        segments
            .get(index)
            .is_some_and(|segment| segment.identity && segment.source.start <= at)
    };
    let mut mask = 0;
    let links = futo_notes_wikilinks::find_wikilinks(source)
        .into_iter()
        .filter(|link| {
            !isolated
                .iter()
                .any(|range| range.start < link.end && link.start < range.end)
                && [link.start, link.start + 1, link.end - 2, link.end - 1]
                    .into_iter()
                    .all(literal)
        })
        .map(|link| {
            mask |= leaf_bit(&link.target);
            RowWikilink {
                source: link.start..link.end,
                target: link.target.into(),
            }
        })
        .collect();
    (links, mask)
}

/// What a renderer shows for one target under one note-id index.
pub(crate) fn describe(target: &str, index: &WikilinkIndex) -> (String, Option<String>) {
    match index.resolve(target) {
        Some(id) => (index.display_suffix(id), Some(id.to_owned())),
        None => (target.to_owned(), None),
    }
}

impl super::Projection {
    pub(crate) fn wikilink_descriptions(
        &self,
        range: crate::DisplayRange,
    ) -> (Vec<crate::WikilinkDescription>, usize) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut items = 0;
        let mut out = Vec::new();
        for index in first..=last {
            let (row, _, display) = self.rows.at(index);
            for link in &row.wikilinks {
                items += 1;
                let described = describe_in_row(row, display, link, &self.catalog);
                if described.range.start.0 <= range.end.0 && range.start.0 <= described.range.end.0
                {
                    out.push(described);
                }
            }
        }
        (out, items)
    }
}

pub(crate) fn describe_in_row(
    row: &Row,
    display: usize,
    link: &RowWikilink,
    index: &WikilinkIndex,
) -> crate::WikilinkDescription {
    let (label, note_id) = describe(&link.target, index);
    crate::WikilinkDescription {
        range: crate::DisplayRange {
            start: crate::DisplayOffset(display + row.display_at(link.source.start)),
            end: crate::DisplayOffset(display + row.display_at(link.source.end)),
        },
        target: link.target.to_string(),
        label,
        note_id,
    }
}

impl super::Projection {
    /// Whether the two `[` bytes at `source` are visible literal text outside
    /// code and HTML: the same condition a finished link's brackets must meet.
    pub(crate) fn opens_literal_wikilink(&self, source: usize) -> bool {
        let (row, row_source, _) = self.rows.at(self.rows.locate(source, false));
        let at = source - row_source;
        let literal = |at: usize| {
            let index = row
                .segments
                .partition_point(|segment| segment.source.end <= at);
            row.segments
                .get(index)
                .is_some_and(|segment| segment.identity && segment.source.start <= at)
        };
        literal(at)
            && literal(at + 1)
            && !row
                .wikilink_isolated
                .iter()
                .any(|range| range.start < at + 2 && at < range.end)
    }
}

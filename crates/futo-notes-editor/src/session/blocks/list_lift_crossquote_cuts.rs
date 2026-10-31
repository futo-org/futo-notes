//! Original canonical fragment retirement and following-owner marker cuts.
use super::*;

pub(super) struct CrossquoteCuts {
    pub spans: Vec<OwnedPrefixShift>,
    pub heads: BTreeMap<usize, SourcePrefix>,
    pub changes: BTreeMap<usize, Vec<(Range<usize>, String)>>,
    pub bodies: BTreeMap<usize, (Range<usize>, String)>,
    pub parsed: usize,
    pub materialized: usize,
}

impl EditorSession {
    pub(super) fn plan_crossquote_cuts(
        &self,
        groups: &[Group],
        items: &[ListLine],
    ) -> Result<CrossquoteCuts, EditorError> {
        let mut spans = Vec::new();
        let mut heads: BTreeMap<usize, SourcePrefix> = BTreeMap::new();
        let mut changes: BTreeMap<usize, Vec<(Range<usize>, String)>> = BTreeMap::new();
        let mut bodies: BTreeMap<usize, (Range<usize>, String)> = BTreeMap::new();
        let mut parsed = 0;
        let mut materialized = 0;
        let mut current = None;
        // One transient borrowed index retains original event order within a
        // quote scope. Each group owns a distinct containing quote scope.
        let mut by_quote: Vec<_> = items
            .iter()
            .enumerate()
            .inspect(|_| {
                crate::inline::visit_container();
            })
            .collect();
        by_quote.sort_by(|(left_at, left), (right_at, right)| {
            crate::inline::visit_container();
            match left.quote_depth.cmp(&right.quote_depth) {
                std::cmp::Ordering::Equal => {
                    crate::inline::visit_container();
                    left_at.cmp(right_at)
                }
                order => order,
            }
        });
        for group in groups {
            crate::inline::visit_container();
            let item = &group.removed;
            let head = self
                .source
                .line_to_byte(self.source.byte_to_line(item.marker.start));
            if current
                .as_ref()
                .is_none_or(|cached: &HeadPrefix| cached.head != head)
            {
                let prefix = self
                    .projection
                    .source_prefix_at(head)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
                materialized += raw.len();
                if !prefix.code {
                    let raw_body = self.source.byte_slice(prefix.content.clone()).to_string();
                    let (protected, work) = super::content::protect_content(&raw_body, false, true);
                    parsed += work;
                    materialized += raw_body.len() + protected.len();
                    if protected != raw_body {
                        let before = raw_body
                            .chars()
                            .zip(protected.chars())
                            .take_while(|(a, b)| a == b)
                            .map(|(ch, _)| ch.len_utf8())
                            .sum::<usize>();
                        let after = raw_body[before..]
                            .chars()
                            .rev()
                            .zip(protected[before..].chars().rev())
                            .take_while(|(a, b)| a == b)
                            .map(|(ch, _)| ch.len_utf8())
                            .sum::<usize>();
                        bodies.insert(
                            prefix.content.start,
                            (
                                prefix.content.start + before..prefix.content.end - after,
                                protected[before..protected.len() - after].to_owned(),
                            ),
                        );
                    }
                }
                heads.entry(head).or_insert(prefix);
                current = Some(HeadPrefix {
                    head,
                    raw,
                    quotes: 0,
                    end: 0,
                    column: 0,
                });
            }
            let base = current
                .as_mut()
                .unwrap()
                .quote_column(item.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let prefix = heads.get(&head).unwrap();
            let mut retired_end = head + item.indent;
            if item.checked.is_some() {
                retired_end += 3;
                if self
                    .source
                    .byte_slice(retired_end..(retired_end + 1).min(self.source.len_bytes()))
                    .bytes()
                    .next()
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                {
                    retired_end += 1;
                }
            }
            if retired_end > prefix.prefix.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            changes
                .entry(head)
                .or_default()
                .push((item.marker.start..retired_end, String::new()));
            let delta = base as isize - item.marker_column as isize;
            if delta != 0 {
                spans.push(OwnedPrefixShift {
                    start: head,
                    item: prefix.source.clone(),
                    quote: item.quote_depth,
                    owner_depth: item.depth,
                    delta,
                });
            }
            let delta = base as isize - item.content_column as isize;
            if delta != 0 {
                spans.push(OwnedPrefixShift {
                    start: prefix.source.end,
                    item: item.item.clone(),
                    quote: item.quote_depth,
                    owner_depth: item.depth,
                    delta,
                });
            }
            let after = self
                .semantic_neighbor(group.root.item.end, true, item.quote_depth)
                .filter(|neighbor| {
                    neighbor
                        .witness
                        .list
                        .as_ref()
                        .is_some_and(|list| list.depth == group.root.depth)
                });
            let mut tail_end = item.item.end;
            let begin = by_quote.partition_point(|(_, child)| {
                crate::inline::visit_container();
                child.quote_depth < item.quote_depth
            });
            let end = by_quote.partition_point(|(_, child)| {
                crate::inline::visit_container();
                child.quote_depth <= item.quote_depth
            });
            for (_, child) in &by_quote[begin..end] {
                crate::inline::visit_container();
                if child.quote_depth != item.quote_depth {
                    continue;
                }
                let descendant = item.item.start <= child.marker.start
                    && child.marker.start < item.item.end
                    && child.depth == item.depth + 1;
                let following = group.root.item != item.item
                    && tail_end <= child.marker.start
                    && child.marker.start < group.root.item.end
                    && child.depth <= item.depth;
                if !descendant && !following {
                    continue;
                }
                let child_head = self
                    .source
                    .line_to_byte(self.source.byte_to_line(child.marker.start));
                let child_prefix = self
                    .projection
                    .source_prefix_at(child_head)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if following {
                    let spelling = self
                        .source
                        .byte_slice(child_prefix.prefix.clone())
                        .to_string();
                    materialized += spelling.len();
                    let quote =
                        super::indent_source::canonical_quote_end(&spelling, child.quote_depth)
                            .ok_or(EditorError::UnrepresentableFormat)?;
                    let column = crate::inline::columns(&spelling[..quote], 0);
                    spans.push(OwnedPrefixShift {
                        start: child_head,
                        item: child.item.clone(),
                        quote: child.quote_depth,
                        owner_depth: child.depth,
                        delta: column as isize - child.marker_column as isize,
                    });
                    tail_end = child.item.end;
                }
                let after_marker = after
                    .as_ref()
                    .filter(|neighbor| {
                        neighbor.witness.list.as_ref().is_some_and(|foreign| {
                            foreign.ordinal.is_some() == child.ordinal.is_some()
                        })
                    })
                    .and_then(|neighbor| neighbor.marker);
                let marker = super::list_styles::independent_marker(
                    child.ordinal.is_some(),
                    None,
                    after_marker,
                );
                changes.entry(child_head).or_default().push((
                    child.marker.end - 1..child.marker.end,
                    (marker as char).to_string(),
                ));
                heads.entry(child_head).or_insert(child_prefix);
            }
        }
        Ok(CrossquoteCuts {
            spans,
            heads,
            changes,
            bodies,
            parsed,
            materialized,
        })
    }
}

/// Only the current physical prefix, never a retained body or ancestor graph.
/// Containing canonical groups are source-ordered and advance through quotes.
struct HeadPrefix {
    head: usize,
    raw: String,
    quotes: usize,
    end: usize,
    column: usize,
}
impl HeadPrefix {
    fn quote_column(&mut self, depth: usize) -> Option<usize> {
        if depth < self.quotes {
            self.quotes = 0;
            self.end = 0;
            self.column = 0;
        }
        while self.quotes < depth {
            let start = self.end;
            let next = self.raw[start..].find('>')?;
            for _ in 0..=next {
                crate::inline::visit_container();
            }
            self.end += next + 1;
            if matches!(self.raw.as_bytes().get(self.end), Some(b' ' | b'\t')) {
                self.end += 1;
            }
            self.column = crate::inline::columns(&self.raw[start..self.end], self.column);
            self.quotes += 1;
        }
        Some(self.column)
    }
}

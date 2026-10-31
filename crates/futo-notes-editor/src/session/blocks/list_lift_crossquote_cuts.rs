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
        for group in groups {
            crate::inline::visit_container();
            let item = &group.removed;
            let head = self
                .source
                .line_to_byte(self.source.byte_to_line(item.marker.start));
            #[cfg(test)]
            trace::record(|ledger| ledger.head_queries += 1);
            let prefix = self
                .projection
                .source_prefix_at(head)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
            materialized += raw.len();
            #[cfg(test)]
            trace::record(|ledger| ledger.prefix_copies += raw.len());
            #[cfg(test)]
            let metadata_before = trace::metadata();
            let quote_end = super::indent_source::canonical_quote_end(&raw, item.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let base = crate::inline::columns(&raw[..quote_end], 0);
            #[cfg(test)]
            trace::record(|ledger| ledger.prefix_metadata += trace::metadata() - metadata_before);
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
            if !prefix.code {
                let raw_body = self.source.byte_slice(prefix.content.clone()).to_string();
                #[cfg(test)]
                trace::record(|ledger| {
                    ledger.body_calls += 1;
                    ledger.body_bytes += raw_body.len();
                });
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
            #[cfg(test)]
            let metadata_before = trace::metadata();
            let after = self
                .semantic_neighbor(group.root.item.end, true, item.quote_depth)
                .filter(|neighbor| {
                    neighbor
                        .witness
                        .list
                        .as_ref()
                        .is_some_and(|list| list.depth == group.root.depth)
                });
            #[cfg(test)]
            trace::record(|ledger| ledger.neighbor_metadata += trace::metadata() - metadata_before);
            let mut tail_end = item.item.end;
            for child in items {
                crate::inline::visit_container();
                #[cfg(test)]
                trace::record(|ledger| ledger.child_visits += 1);
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
            heads.entry(head).or_insert(prefix);
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

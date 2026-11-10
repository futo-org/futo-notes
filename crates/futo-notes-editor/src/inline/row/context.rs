//! A row cut inside a nested list (#314). Its first item continues a list
//! whose ancestor items lie in earlier rows, so the row is the parse of
//! synthetic ancestor lines (each an item with an empty heading at the
//! ancestor's marker and content columns) followed by its own text, with the
//! ancestors' records dropped. List ranges reaching into the ancestors start
//! at the row; projection queries resolve them across rows.
use super::*;

impl Row {
    pub(crate) fn list_continuation(
        context: &str,
        text: &str,
        references: &Arc<crate::inline::references::References>,
        winners: &[crate::inline::references::Winner],
    ) -> Self {
        let skip = context.len();
        let shifted: Vec<_> = winners
            .iter()
            .map(|winner| crate::inline::references::Winner {
                range: winner.range.start + skip..winner.range.end + skip,
                key: winner.key.clone(),
            })
            .collect();
        let joined = format!("{context}{text}");
        let full = Self::parse_with_references(&joined, references, &shifted);
        let shown = full.display_at(skip);
        let back = |range: &Range<usize>| range.start.max(skip) - skip..range.end.max(skip) - skip;
        let context_ends = full
            .blocks
            .iter()
            .take_while(|block| block.source.start < skip)
            .filter_map(|block| block.list.as_ref())
            .map(|list| (list.item.end - skip, list.owner.end - skip))
            .collect();
        let segments = full
            .segments
            .iter()
            .filter(|segment| segment.source.start >= skip)
            .map(|segment| Segment {
                source: back(&segment.source),
                display: segment.display.start - shown..segment.display.end - shown,
                identity: segment.identity,
            })
            .collect();
        let blocks = full
            .blocks
            .iter()
            .filter(|block| block.source.start >= skip)
            .map(|block| shifted_block(block, skip))
            .collect();
        let shift_span = |span: &Span| Span {
            kind: span.kind.clone(),
            open: back(&span.open),
            close: back(&span.close),
        };
        let (table_scan, table_read) = crate::table::RowScan::counted(text);
        Self {
            source_len: text.len(),
            pipes: text.contains('|'),
            table_scan,
            parsed_source_bytes: full.parsed_source_bytes + table_read,
            guarded_words: Vec::new(),
            images: moved(&full.images, skip, |image| &mut image.source),
            wikilinks: moved(&full.wikilinks, skip, |link| &mut link.source),
            wikilink_mask: full.wikilink_mask,
            wikilink_isolated: full
                .wikilink_isolated
                .iter()
                .filter(|range| range.end > skip)
                .map(back)
                .collect(),
            typed_inputs: Vec::new(),
            literal_delimiters: Vec::new(),
            literal_links: Vec::new(),
            definitions: moved(&full.definitions, skip, |definition| &mut definition.range),
            reference_uses: moved(&full.reference_uses, skip, |used| &mut used.range),
            reference_work: full.reference_work,
            display: full.display[shown..].to_owned(),
            segments,
            spans: full
                .spans
                .iter()
                .filter(|span| span.open.start >= skip)
                .map(shift_span)
                .collect(),
            blocks,
            continues: true,
            mid_line: false,
            through: false,
            metadata: false,
            opener: None,
            context: Some(context.into()),
            context_ends,
            tail_chain: full
                .tail_chain
                .iter()
                .map(|&(item, owner)| (item.max(skip) - skip, owner.max(skip) - skip))
                .collect(),
        }
    }

    /// The list depth of a continued list row's first item, or zero when the
    /// row starts a fresh block or continues no list.
    pub(crate) fn start_depth(&self) -> usize {
        if !self.continues || self.opener.is_some() {
            return 0;
        }
        match self.blocks.first().and_then(|block| block.list.as_ref()) {
            Some(_) => self.context_ends.len() + 1,
            None => 0,
        }
    }
}

/// A block of a parse after `skip` context bytes, in row coordinates; list
/// ranges reaching into the context start at the row.
fn shifted_block(
    block: &crate::inline::blocks::BlockLine,
    skip: usize,
) -> crate::inline::blocks::BlockLine {
    let back = |range: &Range<usize>| range.start.max(skip) - skip..range.end.max(skip) - skip;
    let mut block = block.clone();
    block.source = back(&block.source);
    block.content = back(&block.content);
    if let Some(list) = &mut block.list {
        for range in [
            &mut list.marker,
            &mut list.owner,
            &mut list.item,
            &mut list.outer_item,
        ] {
            *range = back(range);
        }
    }
    if let Some(task) = &mut block.task {
        *task = back(task);
    }
    if let Some(fence) = &mut block.fence {
        fence.back(skip);
    }
    for physical in block.bodies.iter_mut().chain(block.underline.iter_mut()) {
        physical.source = back(&physical.source);
        physical.content = back(&physical.content);
    }
    block
}

/// The records starting after `skip` context bytes, in row coordinates.
fn moved<T: Clone>(
    items: &[T],
    skip: usize,
    range: impl Fn(&mut T) -> &mut Range<usize>,
) -> Vec<T> {
    items
        .iter()
        .cloned()
        .filter_map(|mut item| {
            let at = range(&mut item);
            if at.start < skip {
                return None;
            }
            *at = at.start - skip..at.end - skip;
            Some(item)
        })
        .collect()
}

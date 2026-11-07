//! A row continuing a cut raw HTML or fenced code block (#314). Neither
//! block's lines carry inline meaning, so the row is the parse of its block's
//! opener line followed by its own text, with the opener's records dropped.
//! A continued fence keeps its row-local frame; projection queries resolve
//! its block-wide ranges from the block's first and last rows.
use super::*;

/// How a row joins its neighbors.
#[derive(Clone, Default)]
pub(crate) struct Shape {
    /// The row's first block continues the preceding row's last block.
    pub continues: bool,
    /// The row continues one block that the following row continues too.
    pub through: bool,
    /// The following row continues this row's last block.
    pub continued: bool,
    /// More source follows the row.
    pub followed: bool,
    /// The opener line of the raw HTML or fenced block this row continues.
    pub opener: Option<String>,
    /// The row starts at a word seam inside its predecessor's last line.
    pub mid_line: bool,
    /// The ancestor lines of the nested list item this row continues.
    pub context: Option<String>,
}

impl Row {
    /// `None` when the parse holds meaning this narrow form cannot move:
    /// inline syntax, links, images or wikilinks inside the continued text.
    pub(crate) fn html_continuation(
        opener: &str,
        text: &str,
        references: &Arc<crate::inline::references::References>,
    ) -> Option<Self> {
        let joined = format!("{opener}{text}");
        let full = Self::parse_with_references(&joined, references, &[]);
        let skip = opener.len();
        let fence = opener.trim_start_matches(' ').starts_with(['`', '~']);
        // A raw HTML opener displays literally; a fence opener is hidden.
        let shown_skip = if fence { 0 } else { skip };
        let shown = full.display.get(..shown_skip)? == &opener[..shown_skip]
            && full.display_at(skip) == shown_skip;
        let inert = shown
            && full.spans.is_empty()
            && full.images.is_empty()
            && full.wikilinks.is_empty()
            && full.definitions.is_empty()
            && full.reference_uses.is_empty()
            && full.literal_links.is_empty()
            && full.literal_delimiters.is_empty()
            && full.blocks.iter().all(|block| {
                block.source.end <= skip && block.source.start < skip
                    || block.source.start >= skip
                        && block.list.is_none()
                        && (block.fence.is_some() == fence && block.code == fence
                            || block.source.is_empty())
                        && block.underline.is_none()
                        && block.task.is_none()
            });
        if !inert {
            return None;
        }
        let back = |range: &Range<usize>| range.start.max(skip) - skip..range.end.max(skip) - skip;
        let shown_back = |range: &Range<usize>| {
            range.start.max(shown_skip) - shown_skip..range.end.max(shown_skip) - shown_skip
        };
        let mut segments = Vec::new();
        for segment in &full.segments {
            if segment.source.end <= skip && segment.display.end <= shown_skip {
                continue;
            }
            if !segment.identity && segment.source.start < skip {
                return None;
            }
            segments.push(Segment {
                source: back(&segment.source),
                display: shown_back(&segment.display),
                identity: segment.identity,
            });
        }
        let display = full.display[shown_skip..].to_owned();
        let dropped = full
            .blocks
            .iter()
            .take_while(|block| block.source.start < skip)
            .count();
        let blocks: Vec<_> = full.blocks[dropped..]
            .iter()
            .cloned()
            .map(|mut block| {
                block.source = back(&block.source);
                block.content = back(&block.content);
                if let Some(fence) = &mut block.fence {
                    fence.back(skip);
                }
                for physical in &mut block.bodies {
                    physical.source = back(&physical.source);
                    physical.content = back(&physical.content);
                }
                block
            })
            .collect();
        Some(Self {
            source_len: text.len(),
            pipes: text.contains('|'),
            table_scan: crate::table::RowScan::new(text),
            parsed_source_bytes: full.parsed_source_bytes + text.len(),
            guarded_words: Vec::new(),
            images: Vec::new(),
            wikilinks: Vec::new(),
            wikilink_mask: 0,
            wikilink_isolated: full
                .wikilink_isolated
                .iter()
                .filter(|range| range.end > skip)
                .map(back)
                .collect(),
            typed_inputs: Vec::new(),
            literal_delimiters: Vec::new(),
            literal_links: Vec::new(),
            definitions: Vec::new(),
            reference_uses: Vec::new(),
            reference_work: full.reference_work,
            display,
            segments,
            spans: Vec::new(),
            blocks,
            continues: true,
            through: false,
            mid_line: false,
            metadata: false,
            opener: Some(opener.into()),
            context: None,
            context_ends: Vec::new(),
            tail_chain: Vec::new(),
        })
    }
}

impl Row {
    /// A row whose open fence the next row continues shows its final line
    /// ending as body text, as the uncut block does; only the block's last
    /// row hides its frame. A closer ending a row that more source follows
    /// shows its line ending as the break before that source.
    fn continue_fence(&mut self, text: &str, continued: bool, followed: bool) {
        let Some(fence) = self
            .blocks
            .iter()
            .rev()
            .find_map(|block| block.fence.as_ref())
        else {
            return;
        };
        let len = text.len();
        let ending = if text.ends_with("\r\n") {
            2
        } else {
            usize::from(text.ends_with('\n'))
        };
        if ending == 0 {
            return;
        }
        if continued && fence.closer.is_none() && fence.whole.end == len {
            shown_ending(len - ending..len, &mut self.segments, &mut self.display);
            return;
        }
        let Some(closer) = fence.closer.clone() else {
            return;
        };
        if !followed || continued {
            return;
        }
        let Some(line) = self
            .blocks
            .iter_mut()
            .rev()
            .find(|block| block.source.start <= closer.start && closer.end <= block.source.end)
        else {
            return;
        };
        // Only a closer line ending the row; its parse saw no following source.
        if line.source.end != len || line.content.start != len {
            return;
        }
        line.content = len - ending..len - ending;
        line.bodies[0].content = line.content.clone();
        shown_ending(len - ending..len, &mut self.segments, &mut self.display);
    }
}

/// Show the hidden line ending `ending` as identity text.
fn shown_ending(ending: Range<usize>, segments: &mut Vec<Segment>, display: &mut String) {
    let mut kept = segments.len();
    while kept > 0
        && segments[kept - 1].source.start >= ending.start
        && segments[kept - 1].display.is_empty()
    {
        kept -= 1;
    }
    if kept < segments.len() && segments[kept..].iter().any(|s| s.source.end > ending.end)
        || segments[..kept]
            .last()
            .is_some_and(|s| s.source.end > ending.start)
    {
        return;
    }
    segments.truncate(kept);
    let bytes: &[&str] = if ending.len() == 2 {
        &["\r", "\n"]
    } else {
        &["\n"]
    };
    for (at, byte) in ending.zip(bytes) {
        segments.push(Segment {
            source: at..at + 1,
            display: display.len()..display.len() + 1,
            identity: true,
        });
        display.push_str(byte);
    }
}

impl Row {
    /// One partition piece: a continued HTML row or an ordinary parse.
    pub(crate) fn piece(
        text: &str,
        shape: &Shape,
        references: &Arc<crate::inline::references::References>,
        winners: &[crate::inline::references::Winner],
    ) -> Self {
        let opener = shape.opener.as_deref();
        if let Some(context) = &shape.context {
            let mut row = Self::list_continuation(context, text, references, winners);
            row.through = shape.through;
            return row;
        }
        let mut row = opener
            .and_then(|opener| Self::html_continuation(opener, text, references))
            .unwrap_or_else(|| Self::parse_with_references(text, references, winners));
        row.continue_fence(text, shape.continued, shape.followed);
        row.continues = shape.continues;
        if shape.continues && opener.is_none() {
            if let Some(first) = row.blocks.first_mut().filter(|block| block.quote_depth > 0) {
                first.quote_start = false;
            }
        }
        row.through = shape.through;
        row.mid_line = shape.mid_line;
        row.opener = opener.map(Into::into);
        row
    }
}

type CandidateFrame = (Option<Arc<str>>, bool, bool, Option<Arc<str>>);

thread_local! {
    /// The opener of the row whose input is being verified, if any, whether
    /// the following row continues its block, whether source follows, and
    /// the row's nested list context.
    static CANDIDATE_OPENER: std::cell::RefCell<CandidateFrame> =
        const { std::cell::RefCell::new((None, false, false, None)) };
}

/// Verification of input within a continued row reads its opener first.
pub(crate) struct CandidateOpener(CandidateFrame);

impl CandidateOpener {
    /// The opener, whether the next row continues the block, whether any
    /// source follows, and the nested list context.
    pub(crate) fn set(opener: CandidateFrame) -> Self {
        Self(CANDIDATE_OPENER.with(|slot| slot.replace(opener)))
    }
}

impl Drop for CandidateOpener {
    fn drop(&mut self) {
        let previous = std::mem::take(&mut self.0);
        CANDIDATE_OPENER.with(|slot| *slot.borrow_mut() = previous);
    }
}

impl Row {
    /// A planned candidate's parse, in its row's HTML context when continued.
    pub(crate) fn candidate(
        text: &str,
        references: &Arc<crate::inline::references::References>,
        winners: &[crate::inline::references::Winner],
    ) -> Self {
        let (opener, continued, followed, context) =
            CANDIDATE_OPENER.with(|slot| slot.borrow().clone());
        if let Some(context) = context {
            return Self::list_continuation(&context, text, references, winners);
        }
        let mut row = opener
            .and_then(|opener| Self::html_continuation(&opener, text, references))
            .unwrap_or_else(|| Self::parse_with_references(text, references, winners));
        row.continue_fence(text, continued, followed);
        row
    }
}

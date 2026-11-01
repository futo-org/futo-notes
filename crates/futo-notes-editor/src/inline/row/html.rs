//! A row continuing a cut raw HTML block (#314). HTML block lines carry no
//! inline meaning, so the row is the parse of its block's opener line followed
//! by its own text, with the opener's records dropped.
use super::*;

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
        let shown = full.display.get(..skip)? == opener;
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
                        && block.fence.is_none()
                        && block.underline.is_none()
                        && block.task.is_none()
            });
        if !inert {
            return None;
        }
        let back = |range: &Range<usize>| range.start.max(skip) - skip..range.end.max(skip) - skip;
        let mut segments = Vec::new();
        for segment in &full.segments {
            if segment.source.end <= skip && segment.display.end <= skip {
                continue;
            }
            if !segment.identity && segment.source.start < skip {
                return None;
            }
            segments.push(Segment {
                source: back(&segment.source),
                display: back(&segment.display),
                identity: segment.identity,
            });
        }
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
                for physical in &mut block.bodies {
                    physical.source = back(&physical.source);
                    physical.content = back(&physical.content);
                }
                block
            })
            .collect();
        let context: Vec<_> = full
            .context
            .iter()
            .filter(|run| run.first >= dropped)
            .map(|run| ContextRun {
                source: back(&run.source),
                first: run.first - dropped,
                last: run.last - dropped,
                transparent_quote: run.transparent_quote,
            })
            .collect();
        let transparent_quote = (context.len() == 1)
            .then(|| context[0].transparent_quote)
            .flatten();
        Some(Self {
            source_len: text.len(),
            parsed_source_bytes: full.parsed_source_bytes,
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
            display: full.display[skip..].to_owned(),
            segments,
            spans: Vec::new(),
            blocks,
            context,
            transparent_quote,
            continues: true,
            through: false,
            metadata: false,
            opener: Some(opener.into()),
        })
    }
}

impl Row {
    /// One partition piece: a continued HTML row or an ordinary parse.
    pub(crate) fn piece(
        text: &str,
        piece: (bool, bool, Option<&str>),
        references: &Arc<crate::inline::references::References>,
        winners: &[crate::inline::references::Winner],
    ) -> Self {
        let (continues, through, opener) = piece;
        let mut row = opener
            .and_then(|opener| Self::html_continuation(opener, text, references))
            .unwrap_or_else(|| Self::parse_with_references(text, references, winners));
        row.continues = continues;
        row.through = through;
        row.opener = opener.map(Into::into);
        row
    }
}

thread_local! {
    /// The HTML opener of the row whose input is being verified, if any.
    static CANDIDATE_OPENER: std::cell::RefCell<Option<Arc<str>>> =
        const { std::cell::RefCell::new(None) };
}

/// Verification of input within a continued HTML row reads its opener first.
pub(crate) struct CandidateOpener(Option<Arc<str>>);

impl CandidateOpener {
    pub(crate) fn set(opener: Option<Arc<str>>) -> Self {
        Self(CANDIDATE_OPENER.with(|slot| slot.replace(opener)))
    }
}

impl Drop for CandidateOpener {
    fn drop(&mut self) {
        let previous = self.0.take();
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
        CANDIDATE_OPENER
            .with(|slot| slot.borrow().clone())
            .and_then(|opener| Self::html_continuation(&opener, text, references))
            .unwrap_or_else(|| Self::parse_with_references(text, references, winners))
    }
}

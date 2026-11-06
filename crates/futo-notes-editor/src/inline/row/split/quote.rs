//! Proven seams in an explicit top-level quote containing only paragraphs.
//! Other containers and lazy/noncanonical prefixes retain their uncut parse.
use super::{
    paragraph::{seam_after, seam_before, Paragraph},
    Cut, CHUNK,
};
use pulldown_cmark::{Event, Tag, TagEnd};
use std::ops::Range;

pub(super) struct Quote {
    pub range: Range<usize>,
    paragraphs: Vec<Paragraph>,
    current: Option<Paragraph>,
    unsupported: bool,
}

pub(super) struct QuoteSeams {
    pub cuts: Vec<(usize, Cut)>,
    pub first_sealed: bool,
    pub tail: QuoteTail,
}

pub(super) struct QuoteTail {
    blank: bool,
    neutral: bool,
    ended: bool,
}

fn body(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    line.strip_prefix("> ")
        .or_else(|| (line == ">").then_some(""))
}

fn neutral(paragraph: &Paragraph) -> bool {
    !paragraph.dangling && paragraph.depth.is_empty() && !paragraph.emphasis
}

impl QuoteTail {
    pub fn continued_by(&self, next: &str) -> bool {
        let Some(next) = body(next) else { return false };
        self.blank || self.neutral && self.ended && (next.is_empty() || seam_before(next, 0))
    }
}

impl Quote {
    pub fn new(range: Range<usize>) -> Self {
        Self {
            range,
            paragraphs: Vec::new(),
            current: None,
            unsupported: false,
        }
    }

    pub fn observe(&mut self, source: &str, event: &Event<'_>, range: &Range<usize>, depth: usize) {
        match event {
            Event::Start(Tag::BlockQuote(_)) if depth == 0 => {}
            Event::Start(Tag::Paragraph) if depth == 1 => {
                self.current = Some(Paragraph::new(range.clone()))
            }
            Event::End(TagEnd::Paragraph) if depth == 1 => {
                if let Some(mut paragraph) = self.current.take() {
                    paragraph.wikilinks(source);
                    self.paragraphs.push(paragraph);
                }
            }
            Event::Start(tag) if super::is_block(tag) => self.unsupported = true,
            _ => {
                if let Some(paragraph) = &mut self.current {
                    paragraph.inline(source, event, range.clone());
                }
            }
        }
    }

    pub fn finish(mut self, source: &str) -> Option<QuoteSeams> {
        let raw = &source[self.range.clone()];
        if self.unsupported
            || self.current.is_some()
            || self.paragraphs.is_empty()
            || raw.split_inclusive('\n').any(|line| body(line).is_none())
        {
            return None;
        }
        let first_blank = body(raw.split_inclusive('\n').next()?)?.is_empty();
        let last_blank = body(raw.split_inclusive('\n').next_back()?)?.is_empty();
        let first_sealed = first_blank || neutral(&self.paragraphs[0]);
        let tail = QuoteTail {
            blank: last_blank,
            neutral: neutral(self.paragraphs.last()?),
            ended: seam_after(source, self.range.end),
        };
        let mut candidates = Vec::new();
        for (index, paragraph) in self.paragraphs.iter_mut().enumerate() {
            let physical = source[..paragraph.range.start]
                .rfind('\n')
                .map_or(0, |at| at + 1);
            // A quote's explicit blank separator stays with its preceding
            // paragraph. No inline construct can cross this paragraph seam.
            if index > 0 {
                candidates.push(physical);
            }
            if !neutral(paragraph) {
                continue;
            }
            paragraph.covered.sort_by_key(|range| range.start);
            let mut covered = paragraph.covered.iter().peekable();
            let mut reach = 0;
            let mut at = physical;
            for line in source[physical..paragraph.range.end].split_inclusive('\n') {
                at += line.len();
                if at >= paragraph.range.end {
                    break;
                }
                while let Some(range) = covered.next_if(|range| range.start < at) {
                    reach = reach.max(range.end);
                }
                let Some(next) = source[at..].split_inclusive('\n').next().and_then(body) else {
                    continue;
                };
                if reach <= at && seam_after(source, at) && seam_before(next, 0) {
                    candidates.push(at);
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        let mut last = self.range.start;
        let cuts = candidates
            .into_iter()
            .filter_map(|at| {
                if at - last < CHUNK {
                    return None;
                }
                last = at;
                Some((at, Cut::Continue))
            })
            .collect();
        Some(QuoteSeams {
            cuts,
            first_sealed,
            tail,
        })
    }
}

//! Placing one pair of marks around a run of a line: every place the
//! marks may go, each spelling, then closing and reopening the formats
//! that cross the run's edges; a candidate is kept only when the line reads
//! back as intended.
use super::super::super::super::line::{Cut, Entry};
use super::super::draft::{
    gap, glyph_range, glyphs, inside, matches, shape, Draft, Expect, Glyph, Shape,
};
use crate::lines::{Span, SpanKind};
use std::ops::Range;

/// How a pair of marks goes around a run.
pub(in super::super) struct Marks {
    /// Opening and closing marks to try, in order.
    pub spellings: Vec<(String, String)>,
    /// Try the innermost places first (code, which formats may surround).
    pub innermost: bool,
    /// The text inside shows literally: take hidden marks out of it first.
    pub literal: bool,
}

/// Write one pair of `marks` around glyphs `run`, so the line reads as
/// `expect` and `check` holds. Tries every place the marks may go and each
/// spelling; then, where bold, italic or strike crosses an edge of the run,
/// closes that span before the mark and reopens it after.
#[allow(clippy::too_many_arguments)]
pub(in super::super) fn wrap_marks(
    draft: &Draft,
    entry: &Entry,
    run: Range<usize>,
    marks: &Marks,
    expect: &[Expect],
    line_shape: &Shape,
    check: &dyn Fn(&Entry) -> bool,
    work: &mut usize,
) -> Option<(Draft, Entry)> {
    let (base, entry) = if marks.literal {
        let base = strip_inside(draft, entry, &run);
        let read = base.read(work);
        (base, read)
    } else {
        (draft.clone(), entry.clone())
    };
    let entry = &entry;
    let glyphs = glyphs(entry);
    if glyphs.len() != expect.len() {
        return None;
    }
    let mut opens = gap(entry, &glyphs, run.start);
    let mut closes = gap(entry, &glyphs, run.end);
    if marks.innermost {
        opens.reverse();
    } else {
        closes.reverse();
    }
    let edges = [
        crossing(entry, &glyphs, run.start),
        crossing(entry, &glyphs, run.end),
    ];
    let split = edges.iter().any(Option::is_some);
    let mut try_text = |text: String| {
        let candidate = base.with_text(text);
        let read = candidate.read(work);
        (shape(&read) == *line_shape
            && matches(&super::super::draft::glyphs(&read), expect)
            && check(&read))
        .then_some((candidate, read))
    };
    for (open, close) in &marks.spellings {
        for &o in &opens {
            for &c in &closes {
                if c < o {
                    continue;
                }
                let mut text = base.text.clone();
                text.insert_str(c, close);
                text.insert_str(o, open);
                if let Some(found) = try_text(text) {
                    return Some(found);
                }
            }
        }
    }
    if !split {
        return None;
    }
    for (open, close) in &marks.spellings {
        let starts: Vec<(usize, String)> = match &edges[0] {
            Some((at, closers, openers)) => vec![(*at, format!("{closers}{open}{openers}"))],
            None => opens.iter().map(|&at| (at, open.clone())).collect(),
        };
        let ends: Vec<(usize, String)> = match &edges[1] {
            Some((at, closers, openers)) => vec![(*at, format!("{closers}{close}{openers}"))],
            None => closes.iter().map(|&at| (at, close.clone())).collect(),
        };
        for (o, open) in &starts {
            for (c, close) in &ends {
                if c < o {
                    continue;
                }
                let mut text = base.text.clone();
                text.insert_str(*c, close);
                text.insert_str(*o, open);
                if let Some(found) = try_text(text) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// The bold, italic and strike spans crossing the edge before glyph
/// `edge`: where to close and reopen them (after the marks of spans ending
/// there, before those starting there), their closing marks innermost
/// first and their opening marks outermost first. `None` when none cross.
fn crossing(entry: &Entry, glyphs: &[Glyph], edge: usize) -> Option<(usize, String, String)> {
    if edge == 0 || edge >= glyphs.len() {
        return None;
    }
    let marked: Vec<(Range<usize>, &Span)> = entry
        .spans
        .iter()
        .filter(|span| !span.open.is_empty() && !span.close.is_empty())
        .map(|span| (glyph_range(glyphs, &inside(span)), span))
        .collect();
    let mut crossing: Vec<&Span> = marked
        .iter()
        .filter(|(range, span)| {
            matches!(
                span.kind,
                SpanKind::Bold | SpanKind::Italic | SpanKind::Strike
            ) && range.start < edge
                && range.end > edge
        })
        .map(|(_, span)| *span)
        .collect();
    if crossing.is_empty() {
        return None;
    }
    let after = marked
        .iter()
        .filter(|(range, _)| range.end == edge)
        .map(|(_, span)| span.close.end)
        .max();
    let before = marked
        .iter()
        .filter(|(range, _)| range.start == edge)
        .map(|(_, span)| span.open.start)
        .min();
    let at = after.or_else(|| gap(entry, glyphs, edge).first().copied())?;
    if before.is_some_and(|before| before < at) {
        return None;
    }
    crossing.sort_by_key(|span| std::cmp::Reverse(span.open.start));
    let closers = crossing
        .iter()
        .map(|span| &entry.text[span.close.clone()])
        .collect();
    let openers = crossing
        .iter()
        .rev()
        .map(|span| &entry.text[span.open.clone()])
        .collect();
    Some((at, closers, openers))
}

/// Code shows its text literally: take every hidden mark and escape
/// backslash inside `run` out first.
fn strip_inside(draft: &Draft, entry: &Entry, run: &Range<usize>) -> Draft {
    let glyphs = glyphs(entry);
    let (Some(first), Some(last)) = (glyphs.get(run.start), glyphs.get(run.end - 1)) else {
        return draft.clone();
    };
    let extent = first.src..last.end;
    let mut text = draft.text.clone();
    for (range, cut) in entry.view.cuts.iter().rev() {
        if matches!(cut, Cut::Syntax | Cut::Escape)
            && extent.start <= range.start
            && range.end <= extent.end
        {
            text.replace_range(range.clone(), "");
        }
    }
    draft.with_text(text)
}

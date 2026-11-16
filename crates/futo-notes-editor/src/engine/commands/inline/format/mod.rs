//! Spelling one format on one line. `respell` is told which visible
//! characters should carry the format; it takes the format's marks off the
//! stretch that changes (and the spans touching it), then writes one pair of
//! marks around each run of characters that should carry it. Each pair is
//! tried at the places its marks may go, in the house spelling first, and
//! kept only when the line then reads as intended: the same visible text,
//! every other character looking as it did, the block unchanged.
use super::super::super::line::{Cut, Entry};
use super::draft::{
    bit, gap, glyph_range, glyphs, inside, matches, regions, shape, Draft, Expect, Glyph, Shape,
    UNSEEN_ON_SPACE,
};
use crate::lines::{Span, SpanKind};
use crate::InlineFormat;
use std::ops::Range;

mod marks;
pub(super) use marks::{wrap_marks, Marks};

fn is_format(format: InlineFormat, kind: &SpanKind) -> bool {
    matches!(
        (format, kind),
        (InlineFormat::Bold, SpanKind::Bold)
            | (InlineFormat::Italic, SpanKind::Italic)
            | (InlineFormat::Strike, SpanKind::Strike)
            | (InlineFormat::Code, SpanKind::Code)
    )
}

/// Marks for `format` around `text`: the house spelling first.
fn spellings(format: InlineFormat, text: &str) -> Vec<(String, String)> {
    let pair = |mark: &str| (mark.to_owned(), mark.to_owned());
    match format {
        InlineFormat::Bold => vec![pair("**"), pair("__")],
        InlineFormat::Italic => vec![pair("*"), pair("_")],
        InlineFormat::Strike => vec![pair("~~")],
        InlineFormat::Code => {
            let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
            let ticks = "`".repeat(longest + 1);
            let pad = if text.starts_with('`') || text.ends_with('`') {
                " "
            } else {
                ""
            };
            vec![(format!("{ticks}{pad}"), format!("{pad}{ticks}"))]
        }
    }
}

/// Glyph ranges a mark can only surround whole: code (for other formats),
/// URLs, images, wikilinks and tags.
fn atoms(entry: &Entry, glyphs: &[Glyph], format: InlineFormat) -> Vec<Range<usize>> {
    entry
        .spans
        .iter()
        .filter(|span| match span.kind {
            SpanKind::Code => format != InlineFormat::Code,
            SpanKind::Url { .. }
            | SpanKind::Image { .. }
            | SpanKind::Wikilink { .. }
            | SpanKind::Tag => true,
            _ => false,
        })
        .map(|span| glyph_range(glyphs, &span.range))
        .filter(|range| !range.is_empty())
        .collect()
}

/// Rewrite `format` on the line so glyph `i` carries it exactly when
/// `want[i]` (spaces take whichever side reads). `entry` is the draft's
/// reading. The rewrite covers the glyphs that change, the glyphs `touched`
/// (what the command was pointed at) and the spans of the format touching
/// either; `join` also takes in spans that only spaces separate from them,
/// as typing on after a space does. Returns the new draft and its reading;
/// `None` when the line cannot read that way.
pub(super) fn respell(
    draft: &Draft,
    entry: &Entry,
    want: &[bool],
    touched: Range<usize>,
    format: InlineFormat,
    join: bool,
    work: &mut usize,
) -> Option<(Draft, Entry)> {
    let glyphs = glyphs(entry);
    if want.len() != glyphs.len() {
        return None;
    }
    let mark = bit(format);
    let has = |i: usize| glyphs[i].style & mark != 0;
    let mut want = want.to_vec();
    for atom in atoms(entry, &glyphs, format) {
        if let Some(i) = atom.clone().find(|&i| want[i] != has(i)) {
            let value = want[i];
            for j in atom {
                want[j] = value;
            }
        }
    }
    let changed: Vec<usize> = (0..glyphs.len())
        .filter(|&i| !glyphs[i].space() && want[i] != has(i))
        .collect();
    let (Some(&first), Some(&last)) = (changed.first(), changed.last()) else {
        return Some((draft.clone(), entry.clone()));
    };
    let spans: Vec<(Range<usize>, &Span)> = entry
        .spans
        .iter()
        .filter(|span| is_format(format, &span.kind))
        .map(|span| (glyph_range(&glyphs, &inside(span)), span))
        .filter(|(range, _)| !range.is_empty())
        .collect();
    let mut stretch = first..last + 1;
    if !touched.is_empty() {
        stretch.start = stretch.start.min(touched.start);
        stretch.end = stretch.end.max(touched.end.min(glyphs.len()));
    }
    let stretch = grown(stretch, &spans, &glyphs, join);
    // The format's marks come off the stretch, and one pair goes around
    // each run of characters that should carry it.
    let cuts: Vec<Range<usize>> = spans
        .iter()
        .filter(|(range, _)| range.start < stretch.end && range.end > stretch.start)
        .flat_map(|(_, span)| [span.open.clone(), span.close.clone()])
        .collect();
    let stripped: Vec<Expect> = glyphs
        .iter()
        .enumerate()
        .map(|(i, glyph)| {
            let mut expect = Expect::same(glyph);
            if stretch.contains(&i) {
                expect.style &= !mark;
            }
            expect
        })
        .collect();
    let runs = runs(entry, &glyphs, &want, stretch.clone());
    let mut expect = stripped.clone();
    for run in &runs {
        for i in run.clone() {
            expect[i].style |= mark;
            if format == InlineFormat::Code {
                expect[i].mask &= !UNSEEN_ON_SPACE;
            }
        }
    }
    // Typing that extends a span keeps the span's own spelling (`__a__`
    // stays `__`); a toggle writes the house spelling.
    let kept = if join {
        spans
            .iter()
            .filter(|(range, _)| range.start < stretch.end && range.end > stretch.start)
            .map(|(range, span)| {
                (
                    range.clone(),
                    entry.text[span.open.clone()].to_owned(),
                    entry.text[span.close.clone()].to_owned(),
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    let plan = Rewrite {
        draft,
        entry,
        glyphs: &glyphs,
        format,
        cuts,
        runs,
        kept,
        line_shape: shape(entry),
    };
    plan.at_once(&expect, work)
        .or_else(|| plan.pair_by_pair(stripped, &expect, work))
}

/// `stretch` grown over the spans (of the format) touching it, and with
/// `join` over those only spaces separate from it.
fn grown(
    mut stretch: Range<usize>,
    spans: &[(Range<usize>, &Span)],
    glyphs: &[Glyph],
    join: bool,
) -> Range<usize> {
    let spaces = |range: Range<usize>| range.clone().all(|i| glyphs[i].space());
    loop {
        let mut grew = false;
        for (range, _) in spans {
            let touches = range.start <= stretch.end && range.end >= stretch.start;
            let near = join
                && ((range.end <= stretch.start && spaces(range.end..stretch.start))
                    || (range.start >= stretch.end && spaces(stretch.end..range.start)));
            if (touches || near) && (range.start < stretch.start || range.end > stretch.end) {
                stretch.start = stretch.start.min(range.start);
                stretch.end = stretch.end.max(range.end);
                grew = true;
            }
        }
        if !grew {
            return stretch;
        }
    }
}

/// One format's rewrite of a line: the marks to take off (`cuts`) and the
/// runs of glyphs to put a pair of marks around.
struct Rewrite<'a> {
    draft: &'a Draft,
    entry: &'a Entry,
    glyphs: &'a [Glyph],
    format: InlineFormat,
    cuts: Vec<Range<usize>>,
    runs: Vec<Range<usize>>,
    /// Spans (glyph range, open, close) whose spelling a run that takes
    /// them in keeps.
    kept: Vec<(Range<usize>, String, String)>,
    line_shape: Shape,
}

impl Rewrite<'_> {
    /// The whole rewrite in one go, each pair at its first place in the
    /// house spelling: one read, which is all most toggles take.
    fn at_once(&self, expect: &[Expect], work: &mut usize) -> Option<(Draft, Entry)> {
        let code = self.format == InlineFormat::Code;
        let mut inserts: Vec<(usize, String)> = Vec::new();
        let mut removed = self.cuts.clone();
        for run in &self.runs {
            let text: String = self.glyphs[run.clone()]
                .iter()
                .map(|glyph| glyph.ch)
                .collect();
            let own = self
                .kept
                .iter()
                .find(|(range, _, _)| range.start < run.end && range.end > run.start)
                .map(|(_, open, close)| (open.clone(), close.clone()));
            let (open, close) = own.unwrap_or_else(|| spellings(self.format, &text).swap_remove(0));
            let opens = gap(self.entry, self.glyphs, run.start);
            let closes = gap(self.entry, self.glyphs, run.end);
            let (o, c) = if code {
                (opens.last()?, closes.first()?)
            } else {
                (opens.first()?, closes.last()?)
            };
            if code {
                let extent = self.glyphs[run.start].src..self.glyphs[run.end - 1].end;
                removed.extend(
                    self.entry
                        .view
                        .cuts
                        .iter()
                        .filter(|(range, cut)| {
                            matches!(cut, Cut::Syntax | Cut::Escape)
                                && extent.start <= range.start
                                && range.end <= extent.end
                        })
                        .map(|(range, _)| range.clone()),
                );
            }
            inserts.push((*o, open));
            inserts.push((*c, close));
        }
        let candidate = self
            .draft
            .with_text(rewritten(&self.draft.text, &removed, &inserts));
        let read = candidate.read(work);
        (shape(&read) == self.line_shape && matches(&super::draft::glyphs(&read), expect))
            .then_some((candidate, read))
    }

    /// The marks off, then one pair at a time, each tried at every place
    /// and in every spelling.
    fn pair_by_pair(
        &self,
        mut current_expect: Vec<Expect>,
        expect: &[Expect],
        work: &mut usize,
    ) -> Option<(Draft, Entry)> {
        let mut cuts = self.cuts.clone();
        cuts.sort_by_key(|cut| std::cmp::Reverse(cut.start));
        let mut current = (self.draft.clone(), self.entry.clone());
        if !cuts.is_empty() {
            let mut text = self.draft.text.clone();
            for cut in &cuts {
                text.replace_range(cut.clone(), "");
            }
            let next = self.draft.with_text(text);
            let read = next.read(work);
            if shape(&read) != self.line_shape
                || !matches(&super::draft::glyphs(&read), &current_expect)
            {
                return None;
            }
            current = (next, read);
        }
        for run in &self.runs {
            for i in run.clone() {
                current_expect[i] = expect[i];
            }
            current = wrap(
                &current.0,
                &current.1,
                run.clone(),
                self.format,
                &current_expect,
                &self.line_shape,
                work,
            )?;
        }
        Some(current)
    }
}

/// `text` with `removed` ranges taken out and each insert written at its
/// offset (offsets of `text`; no offset lies strictly inside a removed range).
fn rewritten(text: &str, removed: &[Range<usize>], inserts: &[(usize, String)]) -> String {
    let mut removed = removed.to_vec();
    removed.sort_by_key(|range| range.start);
    let mut inserts: Vec<&(usize, String)> = inserts.iter().collect();
    inserts.sort_by_key(|(at, _)| *at);
    let mut out = String::with_capacity(text.len() + 16);
    let keep = |out: &mut String, from: usize, to: usize| {
        let mut at = from;
        for range in &removed {
            if range.end <= at || range.start >= to {
                continue;
            }
            out.push_str(&text[at..range.start.max(at)]);
            at = range.end.min(to).max(at);
        }
        out.push_str(&text[at..to]);
    };
    let mut at = 0;
    for (place, mark) in inserts {
        keep(&mut out, at, *place);
        out.push_str(mark);
        at = *place;
    }
    keep(&mut out, at, text.len());
    out
}

/// The runs of glyphs in `stretch` that should carry the format: within one
/// region (the line's text or one table cell), no edge on a space, and cut
/// where a run would cover part of a link's label.
pub(super) fn runs(
    entry: &Entry,
    glyphs: &[Glyph],
    want: &[bool],
    stretch: Range<usize>,
) -> Vec<Range<usize>> {
    let regions = regions(entry);
    let region_of = |i: usize| {
        regions
            .iter()
            .position(|region| region.start <= glyphs[i].src && glyphs[i].src < region.end)
    };
    let mut runs: Vec<Range<usize>> = Vec::new();
    let mut open: Option<(Range<usize>, Option<usize>)> = None;
    for i in stretch {
        let region = region_of(i);
        let on = want[i] && region.is_some();
        let space = glyphs[i].space();
        if let Some((run, at)) = &open {
            if region != *at || (!space && !on) {
                runs.push(run.clone());
                open = None;
            }
        }
        if !space && on {
            open = Some(match open.take() {
                Some((run, at)) => (run.start..i + 1, at),
                None => (i..i + 1, region),
            });
        }
    }
    if let Some((run, _)) = open {
        runs.push(run);
    }
    let labels: Vec<Range<usize>> = entry
        .spans
        .iter()
        .filter(|span| matches!(span.kind, SpanKind::Link { .. }))
        .map(|span| glyph_range(glyphs, &inside(span)))
        .filter(|label| !label.is_empty())
        .collect();
    let mut out = Vec::new();
    for run in runs {
        let mut cuts: Vec<usize> = labels
            .iter()
            .filter(|label| {
                label.start < run.end
                    && run.start < label.end
                    && !(run.start <= label.start && label.end <= run.end)
                    && !(label.start <= run.start && run.end <= label.end)
            })
            .flat_map(|label| [label.start, label.end])
            .filter(|&at| run.start < at && at < run.end)
            .collect();
        cuts.sort_unstable();
        cuts.dedup();
        let mut start = run.start;
        for end in cuts.into_iter().chain([run.end]) {
            let mut piece = start..end;
            while piece.start < piece.end && glyphs[piece.start].space() {
                piece.start += 1;
            }
            while piece.end > piece.start && glyphs[piece.end - 1].space() {
                piece.end -= 1;
            }
            if !piece.is_empty() {
                out.push(piece);
            }
            start = end;
        }
    }
    out
}

/// Write one pair of `format` marks around glyphs `run` of `draft` (read
/// as `entry`), so the line reads as `expect`.
fn wrap(
    draft: &Draft,
    entry: &Entry,
    run: Range<usize>,
    format: InlineFormat,
    expect: &[Expect],
    line_shape: &Shape,
    work: &mut usize,
) -> Option<(Draft, Entry)> {
    let text: String = expect[run.clone()].iter().map(|want| want.ch).collect();
    let code = format == InlineFormat::Code;
    let marks = Marks {
        spellings: spellings(format, &text),
        innermost: code,
        literal: code,
    };
    wrap_marks(
        draft,
        entry,
        run,
        &marks,
        expect,
        line_shape,
        &|_| true,
        work,
    )
}

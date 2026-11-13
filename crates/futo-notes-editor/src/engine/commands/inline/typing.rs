//! Typing with carried formats, and deletions that keep a span's format.
//!
//! Typing writes marks in one place only: at a collapsed caret whose
//! formats the toolbar set (`Engine.formats`). The typed text then reads in
//! exactly those formats and every other character keeps its own. A text
//! service's replacement of the word before such a caret counts as typing
//! that word: a word the caret's own formats covered, or one the service
//! changed rather than extended, takes the carried formats whole; any other
//! word only on the letters the service added.
use super::super::super::line::Entry;
use super::super::super::{read, store, Engine};
use super::draft::{
    bit, formats_of, gap, glyph_range, glyphs, inline_line, matches, shape, Draft, Expect, Glyph,
    MARKS, UNSEEN_ON_SPACE,
};
use super::format::respell;
use crate::lines::SpanKind;
use crate::{DisplayRange, InlineFormat};
use std::ops::Range;

/// A planned edit: replace source `range` with `inserted`; the caret ends
/// at source `caret` of the new text.
pub(crate) struct Typed {
    pub range: Range<usize>,
    pub inserted: String,
    pub caret: usize,
    /// Bytes of source read to choose the spelling.
    pub parsed: usize,
    /// Formats the caret carries after the edit, when the edit starts
    /// carrying them (a space typed at a span's end).
    pub carry: Option<Vec<InlineFormat>>,
}

/// The edit turning `old` into `new` (both line `start` onward), trimmed to
/// what differs.
pub(super) fn difference(start: usize, old: &str, new: &str) -> (Range<usize>, String) {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let most = old.len().min(new.len()) - prefix;
    let mut suffix = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(most)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    (
        start + prefix..start + old.len() - suffix,
        new[prefix..new.len() - suffix].to_owned(),
    )
}

const ORDER: [InlineFormat; 4] = [
    InlineFormat::Strike,
    InlineFormat::Bold,
    InlineFormat::Italic,
    InlineFormat::Code,
];

impl Engine {
    /// The formats the reading gives the collapsed caret, whatever is carried.
    pub(super) fn read_formats(&self) -> Vec<InlineFormat> {
        let at = self.caret_source();
        let (index, before) = read::line_at(&self.store, at);
        let local = at - before.source;
        let style = self
            .store
            .get(index)
            .spans
            .iter()
            .filter(|span| span.open.end <= local && local <= span.close.start)
            .fold(0, |style, span| style | super::draft::span_bit(&span.kind));
        formats_of(style)
    }

    /// The formats a space typed at collapsed `range` may carry unseen
    /// (bold, italic, strike), read from where the input lands, whether or
    /// not the selection is there.
    fn space_formats(&self, range: DisplayRange, text: &str) -> Option<Vec<InlineFormat>> {
        if range.start != range.end
            || text.is_empty()
            || !text.chars().all(|ch| ch == ' ' || ch == '\t')
        {
            return None;
        }
        let formats: Vec<InlineFormat> = self
            .formats_at(self.input_at(range))
            .into_iter()
            .filter(|format| bit(*format) & UNSEEN_ON_SPACE != 0)
            .collect();
        (!formats.is_empty()).then_some(formats)
    }

    /// Input over display `range` that the carried formats shape: typing at
    /// the collapsed caret, or a text service replacing the word that ends
    /// there. `None` leaves the input to the ordinary plan.
    pub(crate) fn formatted_input(&self, range: DisplayRange, text: &str) -> Option<Typed> {
        // A space typed where a span ends carries the span's formats though
        // the toolbar set none: it lands outside the marks when inside would
        // unpair them, and the next character joins the span again.
        let read = self
            .formats
            .is_none()
            .then(|| self.space_formats(range, text));
        let formats: &[InlineFormat] = match (&self.formats, &read) {
            (Some(formats), _) => formats,
            (None, Some(Some(formats))) => formats,
            _ => return None,
        };
        // Carried formats belong to the caret; a space read where it lands
        // needs no caret there.
        let caret = range.end.0;
        let at_caret = self.selection.start.0 == caret && self.selection.end.0 == caret;
        if text.is_empty()
            || text.contains(['\n', '\r'])
            || (self.formats.is_some() && !at_caret)
            || self.empty_line(caret).is_some()
        {
            return None;
        }
        let (index, before) = self.line_at_display(store::display, caret);
        let entry = self.store.get(index);
        if !inline_line(entry) || range.start.0 < before.display {
            return None;
        }
        let glyphs = glyphs(entry);
        let at = glyphs.partition_point(|glyph| before.display + glyph.display < caret);
        if range.start == range.end {
            if self.quote_space(self.input_at(range), text) {
                return quote_typed(entry, before.source, text, formats);
            }
            let pin = self.input_at(range) - before.source;
            let mut places = gap(entry, &glyphs, at);
            places.sort_by_key(|&place| place != pin);
            let typed = typed_in(
                entry,
                before.source,
                &glyphs,
                at..at,
                &places,
                text,
                formats,
            )?;
            if self.formats.is_some() {
                return Some(typed);
            }
            // Where plain typing would land the space, it takes that path.
            let source = before.source + pin;
            if typed.range == (source..source) && typed.inserted == text {
                return None;
            }
            return Some(Typed {
                carry: Some(formats.to_vec()),
                ..typed
            });
        }
        let from = glyphs.partition_point(|glyph| before.display + glyph.display < range.start.0);
        let word = &glyphs[from..at];
        let style = word.first()?.style;
        let whole = word
            .iter()
            .all(|glyph| glyph.style == style && !glyph.space())
            && !holds_link(entry, &(word[0].src..word[word.len() - 1].end))
            && formats_of(style) == self.read_formats();
        let old: String = word.iter().map(|glyph| glyph.ch).collect();
        let added = text.strip_prefix(old.as_str());
        if whole || added.is_none() {
            // The service rewrote a word the caret's formats covered, or
            // changed what was there: the carried formats take all of it.
            let cut = word[0].src..word[word.len() - 1].end;
            let mut places = gap(entry, &glyphs, from);
            places.extend(
                gap(entry, &glyphs, at)
                    .into_iter()
                    .map(|place| place - cut.len()),
            );
            places.dedup();
            return typed_in(
                entry,
                before.source,
                &glyphs,
                from..at,
                &places,
                text,
                formats,
            );
        }
        // Otherwise only letters added at the caret take them.
        let added = added?;
        if added.is_empty() {
            return None;
        }
        let pin = self.caret_source() - before.source;
        let mut places = gap(entry, &glyphs, at);
        places.sort_by_key(|&place| place != pin);
        typed_in(
            entry,
            before.source,
            &glyphs,
            at..at,
            &places,
            added,
            formats,
        )
    }

    /// A deletion inside one line that leaves a bold, italic or strike span
    /// with a space at its edge, where its marks would no longer pair
    /// (`**b c**` less `c` reads `**b **`): the space moves outside the
    /// marks, so the span keeps its format. `None` when nothing needs that.
    pub(crate) fn kept_formats(&self, range: &Range<usize>, inserted: &str) -> Option<Typed> {
        if !inserted.is_empty() || range.is_empty() {
            return None;
        }
        let (index, before) = read::line_at(&self.store, range.start);
        let entry = self.store.get(index);
        let cut = range.start - before.source..range.end - before.source;
        if cut.end > entry.body_len() || !inline_line(entry) {
            return None;
        }
        let glyphs = glyphs(entry);
        let removed = glyph_range(&glyphs, &cut);
        let expect: Vec<Expect> = glyphs[..removed.start]
            .iter()
            .chain(&glyphs[removed.end..])
            .map(Expect::same)
            .collect();
        let draft = Draft::of(entry);
        let mut text = entry.text.clone();
        text.replace_range(cut.clone(), "");
        let map = |at: usize| {
            if at <= cut.start {
                at
            } else {
                at.max(cut.end) - cut.len()
            }
        };
        let outside = |piece: &Range<usize>| piece.end <= cut.start || piece.start >= cut.end;
        let mut spans: Vec<(Range<usize>, Range<usize>)> = entry
            .spans
            .iter()
            .filter(|span| {
                matches!(
                    span.kind,
                    SpanKind::Bold | SpanKind::Italic | SpanKind::Strike
                )
            })
            .filter(|span| outside(&span.open) && outside(&span.close))
            .filter(|span| span.open.end <= cut.end && cut.start <= span.close.start)
            .map(|span| {
                (
                    map(span.open.start)..map(span.open.end),
                    map(span.close.start)..map(span.close.end),
                )
            })
            .collect();
        // A mark next to a space no longer pairs; with none, nothing to do.
        let edged = |(open, close): &(Range<usize>, Range<usize>)| {
            let content = &text[open.end..close.start];
            !content.trim().is_empty()
                && (content.starts_with(char::is_whitespace)
                    || content.ends_with(char::is_whitespace))
        };
        if !spans.iter().any(edged) {
            return None;
        }
        // Innermost first: a closing mark before the others it nests in.
        spans.sort_by_key(|(_, close)| close.start);
        for (open, close) in &spans {
            let content = &text[open.end..close.start];
            let trailing = content.len() - content.trim_end().len();
            if trailing > 0 && trailing < content.len() {
                let spaces = text[close.start - trailing..close.start].to_owned();
                text.insert_str(close.end, &spaces);
                text.replace_range(close.start - trailing..close.start, "");
            }
            let content = &text[open.end..close.start];
            let leading = content.len() - content.trim_start().len();
            if leading > 0 && leading < content.len() {
                let spaces = text[open.end..open.end + leading].to_owned();
                text.replace_range(open.end..open.end + leading, "");
                text.insert_str(open.start, &spaces);
            }
        }
        let kept = draft.with_text(text);
        let mut work = 0;
        let read = kept.read(&mut work);
        let after = super::draft::glyphs(&read);
        if shape(&read) != shape(entry) || !matches(&after, &expect) {
            return None;
        }
        let display = glyphs
            .get(removed.start)
            .map_or(entry.shown_len(), |glyph| glyph.display);
        let (caret, _) = read.sources(display, true)?;
        let (range, inserted) = difference(before.source, &entry.text, &kept.text);
        Some(Typed {
            range,
            inserted,
            caret: before.source + caret,
            parsed: work,
            carry: None,
        })
    }
}

/// Whether a link, wikilink, image or tag lies wholly in source `range` of
/// `entry`. A word inside a link's text is the link's to keep; a word
/// holding a whole one is not one word to rewrite.
fn holds_link(entry: &Entry, range: &Range<usize>) -> bool {
    entry.spans.iter().any(|span| {
        let text = super::draft::inside(span);
        super::draft::span_bit(&span.kind) & MARKS != 0
            && range.start <= text.start
            && text.end <= range.end
    })
}

/// `entry`'s text without glyphs `removed`, and `places` (offsets of the
/// line once those glyphs' source is gone) moved to match. The marks of a
/// bold, italic, strike or code span left with no glyph go too, as a
/// replaced selection drops them: the text is written in its formats
/// afresh, and marks left around it would no longer pair.
fn without(
    entry: &Entry,
    glyphs: &[Glyph],
    removed: &Range<usize>,
    places: &[usize],
) -> (String, Vec<usize>) {
    let mut base = entry.text.clone();
    let mut places = places.to_vec();
    if removed.is_empty() {
        return (base, places);
    }
    let cut = glyphs[removed.start].src..glyphs[removed.end - 1].end;
    base.replace_range(cut.clone(), "");
    let after = |at: usize| if at <= cut.start { at } else { at - cut.len() };
    let mut marks: Vec<Range<usize>> = entry
        .spans
        .iter()
        .filter(|span| {
            matches!(
                span.kind,
                SpanKind::Bold | SpanKind::Italic | SpanKind::Strike | SpanKind::Code
            )
        })
        .filter(|span| {
            let text = super::draft::inside(span);
            let mut held = glyphs
                .iter()
                .enumerate()
                .filter(|(_, g)| text.contains(&g.src));
            held.clone().next().is_some() && held.all(|(i, _)| removed.contains(&i))
        })
        .flat_map(|span| [span.open.clone(), span.close.clone()])
        .filter(|mark| !mark.is_empty() && (mark.end <= cut.start || mark.start >= cut.end))
        .map(|mark| after(mark.start)..after(mark.end))
        .collect();
    marks.sort_by_key(|mark| std::cmp::Reverse(mark.start));
    for mark in marks {
        base.replace_range(mark.clone(), "");
        for place in &mut places {
            if *place > mark.start {
                *place = (*place).max(mark.end) - mark.len();
            }
        }
    }
    places.dedup();
    (base, places)
}

/// Replace glyphs `removed` of `entry` (whose line starts at source
/// `start`) with `text`, written at the first of `places` (source offsets
/// of the line once those glyphs' source is gone) where the line can read
/// with `text` in exactly `formats` and every other glyph as it was.
/// Typing under carried formats on an empty quote line that needs its
/// space (display rule 6): typed as on the line with that space, which the
/// edit then writes too.
fn quote_typed(entry: &Entry, start: usize, text: &str, formats: &[InlineFormat]) -> Option<Typed> {
    let body = entry.body_len();
    let mut line = entry.text.clone();
    line.insert(body, ' ');
    let mut parsed = 0;
    let spaced = Draft::of(entry).with_text(line).read(&mut parsed);
    let typed = typed_in(
        &spaced,
        start,
        &glyphs(&spaced),
        0..0,
        &[body + 1],
        text,
        formats,
    )?;
    // Past the space, the spaced line's offsets are the note's plus one.
    (typed.range.start > start + body).then(|| Typed {
        range: typed.range.start - 1..typed.range.end - 1,
        inserted: format!(" {}", typed.inserted),
        parsed: typed.parsed + parsed,
        ..typed
    })
}

fn typed_in(
    entry: &Entry,
    start: usize,
    glyphs: &[Glyph],
    removed: Range<usize>,
    places: &[usize],
    text: &str,
    formats: &[InlineFormat],
) -> Option<Typed> {
    let draft = Draft::of(entry);
    let (base, places) = without(entry, glyphs, &removed, places);
    let typed: Vec<char> = text.chars().collect();
    let wanted = formats.iter().fold(0, |style, format| style | bit(*format));
    let at = removed.start;
    let new = at..at + typed.len();
    let mut expect: Vec<Expect> = glyphs[..at].iter().map(Expect::same).collect();
    expect.extend(typed.iter().map(|&ch| Expect {
        ch,
        style: 0,
        mask: 0,
    }));
    expect.extend(glyphs[removed.end..].iter().map(Expect::same));
    let mut work = 0;
    // What the typed text makes of the line, written plainly where the
    // caret is: marks must not change it, nor move the text into or out of
    // a link, wikilink, image or tag.
    let mut line_shape = None;
    let mut plain_marks = None;
    for &place in &places {
        let mut written = base.clone();
        written.insert_str(place, text);
        let written = draft.with_text(written);
        let read = written.read(&mut work);
        let line_shape = line_shape.get_or_insert_with(|| shape(&read)).clone();
        let plain_marks: &Option<Vec<u16>> = plain_marks.get_or_insert_with(|| {
            let plain = super::draft::glyphs(&read);
            (plain.len() == expect.len())
                .then(|| plain[new.clone()].iter().map(|g| g.style & MARKS).collect())
        });
        if shape(&read) != line_shape || !matches(&super::draft::glyphs(&read), &expect) {
            continue;
        }
        let mut current = (written, read);
        let mut formatted = true;
        for format in ORDER {
            let mark = bit(format);
            let want: Vec<bool> = expect
                .iter()
                .enumerate()
                .map(|(i, want)| {
                    if new.contains(&i) {
                        wanted & mark != 0
                    } else {
                        want.style & mark != 0
                    }
                })
                .collect();
            match respell(
                &current.0,
                &current.1,
                &want,
                new.clone(),
                format,
                true,
                &mut work,
            ) {
                Some(next) => current = next,
                None => {
                    formatted = false;
                    break;
                }
            }
        }
        if !formatted {
            continue;
        }
        let mut done = expect.clone();
        for (i, want) in done.iter_mut().enumerate() {
            if new.contains(&i) {
                let marks = plain_marks.as_ref().map(|marks| marks[i - new.start]);
                want.style = wanted | marks.unwrap_or(0);
                let unseen = if want.ch.is_whitespace() {
                    UNSEEN_ON_SPACE
                } else {
                    0
                };
                want.mask = !(unseen | if marks.is_some() { 0 } else { MARKS });
            }
        }
        let (current, read) = current;
        let after = super::draft::glyphs(&read);
        if shape(&read) != line_shape || !matches(&after, &done) {
            continue;
        }
        let caret = match new.end.checked_sub(1) {
            Some(last) => after[last].end,
            None => place,
        };
        let (range, inserted) = difference(start, &entry.text, &current.text);
        return Some(Typed {
            range,
            inserted,
            caret: start + caret,
            parsed: work,
            carry: None,
        });
    }
    None
}

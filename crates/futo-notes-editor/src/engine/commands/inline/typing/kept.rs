//! Deletions that keep a span's format.
use super::super::super::super::{read, Engine};
use super::super::draft::{glyph_range, glyphs, inline_line, matches, shape, Draft, Expect};
use super::{difference, Typed};
use crate::lines::SpanKind;
use std::ops::Range;

impl Engine {
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
        // Only now read the line glyph by glyph: most deletions leave no
        // span edged, and a long line is costly to walk.
        let glyphs = glyphs(entry);
        let removed = glyph_range(&glyphs, &cut);
        let expect: Vec<Expect> = glyphs[..removed.start]
            .iter()
            .chain(&glyphs[removed.end..])
            .map(Expect::same)
            .collect();
        let draft = Draft::of(entry);
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
        let after = super::super::draft::glyphs(&read);
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

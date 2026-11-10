//! One word's own formats, when it has exactly one set of them.
use super::*;
use row::SpanKind;
use std::ops::Range;

impl Projection {
    /// The inline formats every character of the display `range` carries, when
    /// the range is one row's text spelled in source exactly as shown (no
    /// markers, escapes or entities inside it), and no link, wikilink, image,
    /// reference or guarded word overlaps or touches it, save an inline link
    /// holding it. Respelling such a word changes nothing but its formats.
    pub(crate) fn plain_word(
        &self,
        source: &Rope,
        range: Range<usize>,
    ) -> Option<Vec<InlineFormat>> {
        let (row, row_source, row_display) = self.rows.at(self.rows.locate(range.start, true));
        let local = range.start.checked_sub(row_display)?..range.end - row_display;
        if local.is_empty() || local.end > row.display.len() {
            return None;
        }
        let (start, end) = (
            row.source_bounds(local.start).1,
            row.source_bounds(local.end).0,
        );
        if end.checked_sub(start)? != local.len()
            || source.get_byte_slice(row_source + start..row_source + end)?
                != row.display[local.clone()]
        {
            return None;
        }
        let touches = |other: &Range<usize>| other.start <= end && start <= other.end;
        let mut formats = Vec::new();
        for span in &row.spans {
            let format = match &span.kind {
                SpanKind::Format(format) => *format,
                // An inline link's text may hold the word after its first letter; a bare,
                // angle or reference link's meaning can follow its text, so it may not.
                SpanKind::Link(meaning) => {
                    let inline = meaning.reference.is_none()
                        && source
                            .get_byte_slice(
                                row_source + span.open.start..row_source + span.open.end,
                            )
                            .is_some_and(|open| open == "[");
                    let within = inline && span.open.end < start && end <= span.close.start;
                    if !within && touches(&(span.open.start..span.close.end)) {
                        return None;
                    }
                    continue;
                }
            };
            if span.open.end <= start && end <= span.close.start {
                formats.push(format);
            } else if span.open.end > start && span.open.start < end
                || span.close.start < end && span.close.end > start
            {
                return None;
            }
        }
        let near = row.wikilinks.iter().any(|link| touches(&link.source))
            || row.images.iter().any(|image| touches(&image.source))
            || row.reference_uses.iter().any(|used| touches(&used.range))
            || row.guarded_words.iter().any(|word| touches(&word.envelope))
            || row.literal_links.iter().any(touches)
            || row
                .typed_inputs
                .iter()
                .any(|typed| touches(&(typed.opener.start..typed.word.end)));
        if near {
            return None;
        }
        formats.sort();
        formats.dedup();
        Some(formats)
    }
}

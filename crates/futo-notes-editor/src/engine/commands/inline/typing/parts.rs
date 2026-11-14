//! An insert under carried formats that the line cannot spell whole, typed
//! as its parts: its leading spaces, its text, its trailing spaces. Each
//! part lands as the same characters typed one at a time there land, so one
//! insert saves what typing it character by character saves (`Hey ` under
//! Code reads `` `Hey ` ``, as `H`, `e`, `y`, ` ` do).
use super::super::super::super::line::Entry;
use super::super::draft::{gap, glyphs, Draft};
use super::{difference, typed_in, Typed};
use crate::InlineFormat;

/// `text` typed at line offset `pin` of `entry` (whose line starts at
/// source `start`) part by part. `None` when it has no outer spaces to
/// split off, or its text cannot take the formats either.
pub(super) fn typed_parts(
    entry: &Entry,
    start: usize,
    pin: usize,
    text: &str,
    formats: &[InlineFormat],
) -> Option<Typed> {
    let core = text.trim_matches(char::is_whitespace);
    if core.is_empty() || core.len() == text.len() {
        return None;
    }
    let lead = text.len() - text.trim_start_matches(char::is_whitespace).len();
    let parts = [&text[..lead], core, &text[lead + core.len()..]];
    let draft = Draft::of(entry);
    let mut line = entry.clone();
    let mut pin = pin;
    let mut parsed = 0;
    for part in parts.into_iter().filter(|part| !part.is_empty()) {
        let glyphs = glyphs(&line);
        let at = glyphs.partition_point(|glyph| glyph.src < pin);
        let mut places = gap(&line, &glyphs, at);
        places.sort_by_key(|&place| place != pin);
        let (range, inserted, caret) =
            match typed_in(&line, 0, &glyphs, at..at, &places, part, formats) {
                Some(typed) => {
                    parsed += typed.parsed;
                    (typed.range, typed.inserted, typed.caret)
                }
                // Spaces the formats cannot hold there land plain, as a
                // space typed alone there does.
                None if part != core => (pin..pin, part.to_owned(), pin + part.len()),
                None => return None,
            };
        let mut written = line.text.clone();
        written.replace_range(range, &inserted);
        line = draft.with_text(written).read(&mut parsed);
        pin = caret;
    }
    let (range, inserted) = difference(start, &entry.text, &line.text);
    Some(Typed {
        range,
        inserted,
        caret: start + pin,
        parsed,
        carry: None,
    })
}

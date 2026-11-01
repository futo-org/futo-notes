//! Every definition occurrence in a source, from pulldown's block parser.
use super::{declaration_eligible, Definition, ReferenceWork, Winner};
use pulldown_cmark::Parser;
use std::{borrow::Cow, collections::HashSet, ops::Range};
use unicase::UniCase;

/// Collect every definition occurrence, including later duplicates omitted by
/// pulldown's first-definition map: each pass hides the labels already found
/// (same bytes, same structure), so the next pass reports the next duplicate.
pub(in crate::inline) fn declarations(
    source: &str,
    winners: &[Winner],
) -> (Vec<Definition>, ReferenceWork) {
    let mut work = ReferenceWork::default();
    if !declaration_eligible(source, &mut work) {
        return (Vec::new(), work);
    }
    // Every definition spells `]:`; once that many are found, none remain.
    let possible = source.matches("]:").count();
    work.items += source.len();
    let mut found: Vec<(Range<usize>, String, String, Option<String>)> = Vec::new();
    let mut starts = HashSet::new();
    let mut hidden = Cow::Borrowed(source);
    loop {
        let parser = Parser::new_ext(&hidden, crate::inline::row::parser_options());
        work.parsed += source.len();
        let before = found.len();
        for (key, definition) in parser.reference_definitions().iter() {
            work.items += 1;
            if starts.insert(definition.span.start) {
                found.push((
                    definition.span.clone(),
                    key.to_string(),
                    definition.dest.to_string(),
                    definition.title.as_ref().map(ToString::to_string),
                ));
            }
        }
        if found.len() == before || found.len() >= possible {
            break;
        }
        let Some(next) = hide_labels(source, found.iter().map(|(range, ..)| range.start)) else {
            break;
        };
        work.copied += next.len();
        hidden = Cow::Owned(next);
    }
    found.sort_by_key(|(range, ..)| range.start);
    let result = found
        .into_iter()
        .map(|(range, label, destination, title)| {
            work.items += 1;
            let witness = winners
                .iter()
                .find(|winner| {
                    work.items += 1;
                    winner.range.start <= range.start && range.end <= winner.range.end
                })
                .map(|winner| winner.key.clone());
            // Only the canonical source occurrence's resolver key may query
            // the canonical use table.
            let key = witness.as_deref().map_or(label, str::to_owned);
            work.copied += key.len() + destination.len() + title.as_ref().map_or(0, String::len);
            Definition {
                range,
                key: UniCase::new(key),
                destination,
                title,
                winner: witness.is_some(),
                witness,
            }
        })
        .collect();
    (result, work)
}

/// Respell the first line of each label opening at `starts` with a control
/// byte absent from `source`. Lengths, line structure and every other label
/// stay put, so pulldown sees the same blocks with those labels made unique.
fn hide_labels(source: &str, starts: impl Iterator<Item = usize>) -> Option<String> {
    let marker = (1u8..=8)
        .chain(14..=31)
        .find(|byte| !source.as_bytes().contains(byte))?;
    let mut bytes = source.as_bytes().to_vec();
    for start in starts {
        let mut at = start + 1;
        let mut renamed = false;
        while let Some(&byte) = bytes.get(at) {
            let width = if byte == b'\\' && bytes.get(at + 1).is_some_and(u8::is_ascii_punctuation)
            {
                2
            } else {
                1
            };
            match byte {
                b']' | b'\n' | b'\r' => break,
                b'\t' | b' ' | 0x0b | 0x0c => {}
                _ => {
                    bytes[at..at + width].fill(marker);
                    renamed = true;
                }
            }
            at += width;
        }
        if !renamed {
            return None;
        }
    }
    // Only ASCII bytes replaced whole UTF-8 sequences within one label line.
    String::from_utf8(bytes).ok()
}

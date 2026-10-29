//! Literal punctuation can become block syntax after a container changes.
use pulldown_cmark::{Event, Parser, Tag};

pub(super) fn protect_content(raw: &str, heading: bool, paragraph: bool) -> (String, usize) {
    let mut output = raw.to_owned();
    let mut parsed = 0;
    if paragraph {
        parsed = raw.len();
        let block = Parser::new(raw).any(|event| {
            matches!(
                event,
                Event::Start(
                    Tag::Heading { .. }
                        | Tag::BlockQuote(_)
                        | Tag::List(_)
                        | Tag::CodeBlock(_)
                        | Tag::HtmlBlock
                ) | Event::Rule
            )
        });
        if block {
            if let Some((at, _)) = raw.char_indices().find(|(_, ch)| ch.is_ascii_punctuation()) {
                output.insert(at, '\\');
            }
        }
    }
    if heading {
        let trimmed = output.trim_end_matches([' ', '\t']);
        let hashes = trimmed.bytes().rev().take_while(|ch| *ch == b'#').count();
        let at = trimmed.len() - hashes;
        if hashes > 0 && (at == 0 || trimmed.as_bytes()[at - 1].is_ascii_whitespace()) {
            output.insert(at, '\\');
        }
    }
    (output, parsed)
}

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
        // ATX separation consumes every leading space/tab. Encode the first
        // visible one so the remaining body keeps its original display spelling.
        if let Some(first @ (' ' | '\t')) = output.chars().next() {
            output.replace_range(..first.len_utf8(), &format!("&#{};", first as u32));
        }
        let trimmed = output.trim_end_matches([' ', '\t']);
        let hashes = trimmed.bytes().rev().take_while(|ch| *ch == b'#').count();
        let at = trimmed.len() - hashes;
        if hashes > 0 && (at == 0 || trimmed.as_bytes()[at - 1].is_ascii_whitespace()) {
            output.insert(at, '\\');
        }
    }
    (output, parsed)
}

/// Container prefixes on later physical setext lines remain syntax. Protect
/// their bodies independently so paragraph punctuation checks cannot escape a
/// retained quote marker.
pub(super) fn protect_block_content(
    raw: &str,
    line: &crate::inline::blocks::BlockLine,
    heading: bool,
    paragraph: bool,
) -> (String, usize) {
    let mut output = String::new();
    let mut parsed = 0;
    let mut at = 0;
    for continuation in &line.continuations {
        let start = continuation.start - line.content.start;
        let end = continuation.end - line.content.start;
        let (part, work) = protect_content(&raw[at..start], heading, paragraph);
        parsed += work;
        output.push_str(&part);
        output.push_str(&raw[start..end]);
        at = end;
    }
    let (part, work) = protect_content(&raw[at..], heading, paragraph);
    output.push_str(&part);
    (output, parsed + work)
}

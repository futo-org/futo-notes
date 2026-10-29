//! Literal punctuation can become block syntax after a container changes.
use super::*;
use crate::inline::blocks::BlockLine;
use pulldown_cmark::{Event, Parser, Tag};

pub(super) struct BodySplit {
    pub left: String,
    pub right: String,
    pub prefixes: Vec<String>,
    pub right_line: usize,
    pub formats: Option<Vec<InlineFormat>>,
    pub affinity: Affinity,
    pub materialized: usize,
    pub parsed: usize,
}

impl EditorSession {
    /// The block owner supplies physical layout; the inline owner spells the
    /// actual displayed body. Coordinates are reused only after equality with
    /// that display is established.
    pub(super) fn split_block_body(
        &self,
        lines: &[BlockLine],
        range: DisplayRange,
    ) -> Result<BodySplit, EditorError> {
        let first = lines.first().unwrap();
        let last = lines.last().unwrap();
        let start = self.projection.display_at(first.content.start);
        let end = self.projection.display_at(last.content.end);
        let body_range = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        };
        let (raw, materialized, parsed) =
            self.projection
                .body_source(&self.source, body_range, false)?;
        let shown = self.projection.display.byte_slice(start..end).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        if staged.display_text() != shown {
            return Err(EditorError::UnrepresentableFormat);
        }
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - start),
            end: DisplayOffset(range.end.0 - start),
        };
        staged.select_with_affinity(staged.revision(), local, self.input_affinity(range))?;
        if range == self.selection {
            staged.pending_formats = self.pending_formats.clone();
        }
        let change = staged.replace_action(
            staged.revision(),
            local,
            "\n\n",
            crate::InputAction::Isolated,
            &mut |_| Ok(()),
        )?;
        let body = staged.source_text();
        let split = staged.projection.source_bounds(local.start.0 + 1).0 - 1;
        if body.get(split..split + 2) != Some("\n\n") {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut prefixes = Vec::new();
        let mut right_line = 0;
        for physical in lines.iter().flat_map(|line| &line.bodies) {
            if self.projection.display_at(physical.content.start) <= range.end.0 {
                right_line = prefixes.len();
            }
            prefixes.push(
                self.source
                    .byte_slice(physical.source.start..physical.content.start)
                    .to_string(),
            );
        }
        let prefix_bytes = prefixes.iter().map(String::len).sum::<usize>();
        Ok(BodySplit {
            left: body[..split].into(),
            right: body[split + 2..].into(),
            prefixes,
            right_line,
            formats: staged.pending_formats,
            affinity: staged.affinity,
            materialized: prefix_bytes
                + materialized
                + raw.len()
                + shown.len()
                + change.work.materialized_source_bytes,
            parsed: parsed + 2 * raw.len() + change.work.parsed_source_bytes,
        })
    }
}

/// Existing physical breaks retain exact container spelling. The planner owns
/// the newly split first line's prefix separately.
pub(super) fn restore_body_prefixes<'a>(
    body: &str,
    mut prefixes: impl Iterator<Item = &'a String>,
) -> String {
    let mut output = String::new();
    for (index, part) in body.split_inclusive('\n').enumerate() {
        if index > 0 {
            if let Some(prefix) = prefixes.next() {
                output.push_str(prefix);
            }
        }
        output.push_str(part);
    }
    output
}

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
    for continuation in line.bodies.iter().skip(1) {
        let start = continuation.source.start - line.content.start;
        let end = continuation.content.start - line.content.start;
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

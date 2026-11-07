//! Literal punctuation can become block syntax after a container changes.
use super::*;
use crate::inline::blocks::BlockLine;
use pulldown_cmark::{Event, Parser, Tag};

pub(super) struct BodySplit {
    pub retired_atoms: Vec<crate::inline::guarded_words::ValidationAtom>,
    pub retained: Vec<crate::inline::references::RetainedBody>,
    pub pending: Option<crate::inline::PendingLinks>,
    pub split: usize,
    pub left: String,
    pub right: String,
    pub prefixes: Vec<String>,
    pub right_line: usize,
    pub formats: Option<Vec<InlineFormat>>,
    pub affinity: Affinity,
    pub materialized: usize,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}

pub(super) struct ParagraphSeparator {
    pub source: String,
    pub comment: bool,
}

impl EditorSession {
    /// A paragraph replacing a block below a list must not become that item's
    /// lazy continuation. An empty paragraph also needs its own margin caret.
    pub(super) fn list_paragraph_separator(
        &self,
        start: usize,
        quotes: usize,
        empty: bool,
    ) -> Option<ParagraphSeparator> {
        let row = self.source.byte_to_line(start);
        let previous = self.source.line_to_byte(row.checked_sub(1)?);
        if self
            .source
            .byte_slice(previous..start)
            .chars()
            .all(|ch| matches!(ch, ' ' | '\t' | '>' | '\r' | '\n'))
        {
            return None;
        }
        let line = self
            .projection
            .list_command_lines_in_source(&(previous..start))
            .pop()?;
        let list = line.list?;
        if quotes > list.quote_depth || !empty && (line.heading > 0 || line.code || line.divider) {
            return None;
        }
        let comment = empty && quotes > 0;
        let quote = "> ".repeat(quotes);
        Some(ParagraphSeparator {
            source: format!(
                "{}{}{}",
                if comment { &quote } else { quote.trim_end() },
                if comment { "<!-- -->" } else { "" },
                self.line_ending_at(start)
            ),
            comment,
        })
    }

    /// Nonempty quote paragraphs can lazily adopt a following lower container.
    /// ATX/rule/code boundaries interrupt that continuation; setext bodies do
    /// not. Retain the next container's exact prefix when separating it.
    pub(super) fn quote_neighbor_separator(
        &self,
        end: usize,
        depth: usize,
        nonempty: bool,
    ) -> Option<(String, usize)> {
        if end >= self.source.len_bytes() {
            return None;
        }
        let point = DisplayOffset(self.projection.display_at(end));
        let next = self
            .projection
            .block_lines(DisplayRange {
                start: point,
                end: point,
            })
            .into_iter()
            .next()?;
        if next.content.is_empty()
            || next.quote_depth >= depth
            || next.code
            || next.divider
            || next.heading > 0
                && (!nonempty
                    || next.heading_syntax != crate::inline::blocks::HeadingSyntax::Setext)
        {
            return None;
        }
        if next.list.as_ref().is_some_and(|list| {
            list.first
                && list.depth == 1
                && list.quote_depth == next.quote_depth
                && matches!(list.ordinal, None | Some(1))
        }) {
            // A canonical nonempty bullet/ordered-one item interrupts the new
            // quote paragraph itself. An extra marker would create a new item.
            return None;
        }
        let prefix = self
            .source
            .byte_slice(next.source.start..next.content.start)
            .to_string();
        let kept = if next.list.is_some() {
            // A noninterrupting ordinal needs a real blank in its retained
            // quote scope. Its list marker belongs only to the untouched item.
            super::indent_source::canonical_quote_end(&prefix, next.quote_depth)?
        } else {
            prefix.len()
        };
        let retained = prefix[..kept].trim_end_matches([' ', '\t']);
        for _ in retained.len()..=kept {}
        let separator = format!("{retained}\n");
        let copied = prefix.len() + separator.len();
        Some((separator, copied))
    }

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
        let rendered =
            self.projection
                .body_source(&self.source, body_range, false, self.revision)?;
        let staging::BodyStage {
            session: mut staged,
            had_pending,
        } = self.stage_body_source(&rendered, first.content.start..last.content.end)?;
        let (inventories, inventory_work) = if rendered
            .guarded_words
            .as_ref()
            .is_some_and(|words| !words.is_empty())
        {
            staged.projection.split_guard_inventory()?
        } else {
            (Vec::new(), Default::default())
        };
        let crate::inline::BodySource {
            text: raw,
            retained,
            materialized,
            parsed,
            work: link_work,
            ..
        } = rendered;
        let shown = self.projection.display.byte_slice(start..end).to_string();
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
        let mut step = None;
        let (change, mapping) = staged.replace_action_mapped(
            staged.revision(),
            local,
            "\n\n",
            crate::InputAction::Isolated,
            &mut |edit| {
                step = Some((edit.previous_revision, edit.range, edit.inserted.len()));
                Ok(())
            },
        )?;
        let (revision, step_range, inserted) = step.ok_or(EditorError::UnrepresentableFormat)?;
        let (separator, separator_work) =
            mapping.inserted_source_range(revision, step_range, inserted, 0..2)?;
        let (retained, witness_work) =
            mapping.transfer_body(revision, step_range, inserted, retained)?;
        let (retired_atoms, retirement_work) =
            mapping.transfer_guard_retirement(revision, step_range, inserted, inventories)?;
        let body = staged.source_text();
        let split = separator.start;
        if body.get(separator) != Some("\n\n") {
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
        let pending = if had_pending {
            Some(
                staged
                    .projection
                    .pending_body(0..staged.source.len_bytes())?,
            )
        } else {
            None
        };
        Ok(BodySplit {
            retired_atoms,
            pending,
            retained,
            split,
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
            parsed: parsed + staged.projection.initial_parse_work + change.work.parsed_source_bytes,
            link_metadata_items: inventory_work.items
                + retirement_work
                + link_work.items
                + witness_work
                + separator_work
                + 2
                + staged.projection.initial_link_metadata_items
                + change.work.link_metadata_items,
            link_copied_bytes: inventory_work.copied
                + link_work.copied
                + staged.projection.initial_link_copied_bytes
                + change.work.link_copied_bytes,
        })
    }
}

/// Existing physical breaks retain exact container spelling. The planner owns
/// the newly split first line's prefix separately.
pub(super) struct PhysicalBody {
    pub text: String,
    copied_parts: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>,
    pub work: usize,
    pub copied: usize,
}
impl PhysicalBody {
    /// Only complete nonempty atom ranges transfer here. A point at an
    /// inserted prefix needs explicit affinity, not this range-only query.
    pub fn retained_range(
        &self,
        range: std::ops::Range<usize>,
    ) -> (Option<std::ops::Range<usize>>, usize) {
        let mut work = 1;
        if range.is_empty() {
            return (None, work);
        }
        let at = self.copied_parts.partition_point(|(before, _)| {
            work += 1;
            before.end <= range.start
        });
        let mapped = self.copied_parts.get(at).and_then(|(before, after)| {
            work += 1;
            (before.start <= range.start && range.end <= before.end).then(|| {
                after.start + range.start - before.start..after.start + range.end - before.start
            })
        });
        (mapped, work)
    }
}

pub(super) fn physical_body<'a>(
    body: &str,
    mut prefixes: impl Iterator<Item = &'a String>,
    retain_origins: bool,
) -> PhysicalBody {
    let mut result = PhysicalBody {
        text: String::new(),
        copied_parts: Vec::new(),
        work: body.len(),
        copied: 0,
    };
    let mut source = 0;
    for (index, part) in body.split_inclusive('\n').enumerate() {
        result.work += 1;
        if index > 0 {
            result.work += 1;
            if let Some(prefix) = prefixes.next() {
                result.text.push_str(prefix);
                result.copied += prefix.len();
            }
        }
        let start = result.text.len();
        result.text.push_str(part);
        result.copied += part.len();
        if retain_origins {
            result.work += 3;
            // These exact input bytes were just pushed. Inserted prefixes
            // receive no origin, even when their spelling equals body text.
            result
                .copied_parts
                .push((source..source + part.len(), start..result.text.len()));
        }
        source += part.len();
    }
    result
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

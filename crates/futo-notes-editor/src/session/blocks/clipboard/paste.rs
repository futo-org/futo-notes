//! Paste: plain text read as Markdown at the caret's line and containers.
use super::*;

/// Where pasted text lands. A table cell (#310) is a further target that joins
/// the pasted lines into one cell line instead of placing blocks.
enum PasteTarget {
    /// Fenced or indented code takes the text verbatim through code input.
    Code,
    /// A paragraph, heading, quote or list line.
    Line,
}

/// The physical line holding a source offset, split at its container/leaf prefix.
struct TargetLine {
    start: usize,
    content: usize,
    prefix: String,
    heading: bool,
    /// List marker start and the item prefix that a split-off tail item reuses.
    list: Option<(usize, String)>,
    /// The line continues a paragraph from the line before.
    soft: bool,
}

impl TargetLine {
    /// Container prefix for a continuation line: quote markers and list
    /// content columns survive, a heading marker does not.
    fn continuation(&self) -> String {
        let prefix = if self.heading {
            let hashes = self.prefix.find('#').unwrap_or(self.prefix.len());
            &self.prefix[..hashes]
        } else {
            &self.prefix
        };
        prefix
            .chars()
            .map(|c| {
                if matches!(c, '>' | ' ' | '\t') {
                    c
                } else {
                    ' '
                }
            })
            .collect()
    }
}

/// Classification of the pasted text, read as its own Markdown document.
struct PastedShape {
    has_block: bool,
    code: bool,
    blank_line: bool,
    first_block: bool,
    first_quote: bool,
    last_container: bool,
    last_paragraph: bool,
    only_list: bool,
    interrupts: bool,
    unclosed_fence: Option<String>,
    /// End of the leading paragraph run that continues the caret's text, and
    /// start of the trailing run that the caret line's tail continues.
    lead: usize,
    trail: usize,
    parsed: usize,
}

impl PastedShape {
    fn read(text: &str) -> Self {
        let projection = crate::inline::Projection::new(text);
        let range = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(projection.display.len_bytes()),
        };
        let lines = projection.block_lines(range);
        let block = |line: &crate::inline::blocks::BlockLine| {
            line.heading > 0
                || line.quote_depth > 0
                || line.divider
                || line.code
                || line.list.is_some()
        };
        let filled: Vec<_> = lines
            .iter()
            .filter(|line| block(line) || line.paragraph_text)
            .collect();
        let paragraph =
            |line: &&crate::inline::blocks::BlockLine| line.paragraph_text && !block(line);
        let lead = lines
            .iter()
            .take_while(paragraph)
            .last()
            .map_or(0, |line| line.content.end);
        let trail = lines
            .iter()
            .rev()
            .take_while(paragraph)
            .last()
            .map_or(text.len(), |line| line.source.start);
        let first = filled.first();
        let last = filled.last();
        let unclosed_fence = last
            .and_then(|line| line.fence.as_ref())
            .filter(|fence| fence.closer.is_none())
            .map(|fence| (fence.marker as char).to_string().repeat(fence.width));
        Self {
            has_block: filled.iter().any(|line| block(line)),
            code: filled.iter().any(|line| line.code),
            blank_line: !filled.is_empty() && text.lines().any(|line| line.trim().is_empty()),
            first_block: first.is_some_and(|line| block(line)),
            first_quote: first.is_some_and(|line| line.quote_depth > 0),
            last_container: last
                .is_some_and(|line| !line.code && (line.list.is_some() || line.quote_depth > 0)),
            last_paragraph: last.is_some_and(|line| !block(line)),
            only_list: !filled.is_empty()
                && first.is_some_and(|line| {
                    line.list
                        .as_ref()
                        .is_some_and(|list| list.depth == 1 && list.marker_column == 0)
                })
                && filled
                    .iter()
                    .all(|line| line.in_list && line.quote_depth == 0 && !line.code),
            // An ordered list must start at one to interrupt a paragraph.
            interrupts: !first.is_some_and(|line| {
                line.list
                    .as_ref()
                    .is_some_and(|list| list.ordinal.is_some_and(|ordinal| ordinal != 1))
            }),
            unclosed_fence,
            lead,
            trail,
            parsed: projection.initial_parse_work,
        }
    }
}

impl EditorSession {
    /// Plain-text paste read as Markdown: copied characters, edge whitespace and
    /// soft lines stay exact; blocks take their own lines inside the caret's
    /// containers; one trailing copied line ending is dropped and pasted line
    /// endings follow the caret line. The paste is one isolated history action.
    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition().is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| {
                    staged.paste_markdown(staged.revision(), local, text, accept)
                },
            );
        }
        self.validate_range(range)?;
        let range = self.outside_crlf(range);
        // Inside a table the paste is one cell's text: edge blank lines go and
        // inner line breaks become one space. Across cells it is refused.
        if let Some(change) = self.paste_in_cell(expected, range, text, accept)? {
            return Ok(Some(change));
        }
        let (low, high) = self.projection.source_bounds(range.start.0);
        let caret = if range.start == range.end && self.input_affinity(range) == Affinity::Backward
        {
            low
        } else {
            high
        };
        let newline = self.line_ending_at(caret);
        let text = normalize_paste(text, newline);
        if text.is_empty() {
            if range.start == range.end {
                return Ok(None);
            }
            return self
                .replace_action(expected, range, "", crate::InputAction::Isolated, accept)
                .map(Some);
        }
        let line = self.target_line(range.start, caret);
        let target = if self
            .projection
            .block_lines(DisplayRange {
                start: range.start,
                end: range.start,
            })
            .iter()
            .any(|block| block.code && block.source.contains(&caret))
        {
            PasteTarget::Code
        } else {
            PasteTarget::Line
        };
        let start = self.split_point(range.start).max(line.content);
        let end = self.split_point(range.end).max(start);
        if let PasteTarget::Code = target {
            // Verbatim: each further line repeats the code line's prefix.
            let prefix = line.continuation();
            let out = prefixed(&text, newline, &prefix, prefix.trim_end());
            let caret = BlockSelection::Source(start + out.len());
            return self
                .commit_block_edit(expected, start..end, &out, caret, None, accept)
                .map(Some);
        }
        let shape = PastedShape::read(&text);
        let literal = if !text.contains(newline) {
            !shape.has_block || shape.code || is_marker(&text)
        } else {
            !shape.has_block && !shape.blank_line
        };
        let mut change = if literal {
            self.replace_action(expected, range, &text, crate::InputAction::Isolated, accept)?
        } else {
            self.place_blocks(expected, start, end, &line, &text, &shape, newline, accept)?
        };
        change.work.parsed_source_bytes += shape.parsed;
        Ok(Some(change))
    }

    #[allow(clippy::too_many_arguments)]
    fn place_blocks(
        &mut self,
        expected: Revision,
        start: usize,
        end: usize,
        line: &TargetLine,
        text: &str,
        shape: &PastedShape,
        newline: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let end_line_end = line_end(&self.source, end);
        let before_empty = start <= line.content;
        let after_empty = end >= end_line_end;
        let continuation = line.continuation();
        let siblings = shape.only_list && line.list.is_some();
        let (lines_prefix, tail_prefix, from) = match (&line.list, siblings) {
            (Some((marker, item)), true) => (
                line.prefix[..marker - line.start].to_owned(),
                format!(
                    "{}{}",
                    &line.prefix[..marker - line.start],
                    item.replace("[x]", "[ ]").replace("[X]", "[ ]")
                ),
                if before_empty { *marker } else { start },
            ),
            // A pasted quote replaces an empty quote line's own marker, as a
            // list replaces an empty item's and a block an empty heading's.
            _ if before_empty && after_empty && shape.first_quote && !line.heading => {
                let outer = line.prefix.trim_end().strip_suffix('>').map(str::len);
                let outer = outer.unwrap_or(continuation.len());
                let prefix = continuation[..outer].to_owned();
                (prefix.clone(), prefix, line.start + outer)
            }
            _ => {
                let tail = if line.heading {
                    line.prefix.clone()
                } else {
                    continuation.clone()
                };
                let from = if before_empty && line.heading && shape.first_block {
                    line.start + continuation.len()
                } else {
                    start
                };
                (continuation.clone(), tail, from)
            }
        };
        let blank = lines_prefix.trim_end().to_owned();
        let mut out = String::with_capacity(text.len() * 2);
        // An ordered list that cannot interrupt the paragraph above starts after a blank line.
        let parted = shape.first_block && !shape.interrupts && !siblings;
        let (from, after_soft) = if parted && before_empty && line.soft {
            (line.start, true)
        } else {
            (from, false)
        };
        if after_soft {
            out.push_str(&blank);
            out.push_str(newline);
            out.push_str(&lines_prefix);
        } else if (shape.first_block || siblings) && !before_empty {
            out.push_str(&self.straddling(start, false));
            out.push_str(newline);
            if parted {
                out.push_str(&blank);
                out.push_str(newline);
            }
            out.push_str(&lines_prefix);
        }
        let tail_needed = if siblings {
            !after_empty
        } else {
            !shape.last_paragraph && !after_empty
        };
        // Spans open across the caret close before the first paragraph break
        // and reopen after the last, as they do around a split-off block.
        let mut text = text.to_owned();
        if !tail_needed && text[..shape.trail].contains(newline) {
            text.insert_str(shape.trail, &self.straddling(end, true));
        }
        if !shape.first_block && !siblings && text[shape.lead..].contains(newline) {
            text.insert_str(shape.lead, &self.straddling(start, false));
        }
        out.push_str(&prefixed(&text, newline, &lines_prefix, &blank));
        if let Some(fence) = &shape.unclosed_fence {
            out.push_str(newline);
            out.push_str(&lines_prefix);
            out.push_str(fence);
        }
        let caret = from + out.len();
        if tail_needed {
            if shape.last_container && !siblings {
                out.push_str(newline);
                out.push_str(&blank);
            }
            out.push_str(newline);
            out.push_str(&tail_prefix);
            out.push_str(&self.straddling(end, true));
        }
        self.commit_block_edit(
            expected,
            from..end,
            &out,
            BlockSelection::Source(caret),
            None,
            accept,
        )
    }

    fn target_line(&self, at: DisplayOffset, caret: usize) -> TargetLine {
        let start = line_start(&self.source, caret);
        let end = line_end(&self.source, caret);
        let blocks = self
            .projection
            .block_lines(DisplayRange { start: at, end: at });
        let block = blocks
            .iter()
            .find(|block| block.source.start <= caret && caret <= block.source.end);
        let content = block
            .and_then(|block| {
                if block.source.start == start {
                    Some(block.content.start)
                } else {
                    block
                        .bodies
                        .iter()
                        .find(|body| body.source.start == start)
                        .map(|body| body.content.start)
                }
            })
            .unwrap_or(start)
            .clamp(start, end);
        let prefix = self.source.byte_slice(start..content).to_string();
        let list = block
            .and_then(|block| block.list.as_ref())
            .filter(|list| (start..content).contains(&list.marker.start))
            .map(|list| {
                (
                    list.marker.start,
                    self.source
                        .byte_slice(list.marker.start..content)
                        .to_string(),
                )
            });
        let soft = start > 0
            && self
                .projection
                .block_lines(DisplayRange {
                    start: DisplayOffset(at.0.saturating_sub(1)),
                    end: at,
                })
                .iter()
                .any(|line| line.source.end == start && line.paragraph_text);
        TargetLine {
            start,
            content,
            prefix,
            soft,
            heading: block.is_some_and(|block| block.heading > 0 && block.source.start == start)
                && self
                    .source
                    .byte_slice(start..content)
                    .chars()
                    .any(|c| c == '#'),
            list,
        }
    }

    /// The caret line's ending, else the preceding line's, else LF.
    fn line_ending_at(&self, at: usize) -> &'static str {
        let end = line_end(&self.source, at);
        let len = self.source.len_bytes();
        let crlf = |at: usize| {
            at + 1 < len && self.source.byte(at) == b'\r' && self.source.byte(at + 1) == b'\n'
        };
        if end < len {
            return if crlf(end) { "\r\n" } else { "\n" };
        }
        let start = line_start(&self.source, at);
        if start >= 2 && crlf(start - 2) {
            "\r\n"
        } else {
            "\n"
        }
    }

    /// Splits the hidden delimiters at a display offset: closers of the
    /// preceding text stay before the point, openers of the following after.
    fn split_point(&self, at: DisplayOffset) -> usize {
        let (low, high) = self.projection.source_bounds(at.0);
        let rows = &self.projection.rows;
        let (row, base, _) = rows.at(rows.locate(low, false));
        row.spans
            .iter()
            .map(|span| shift(&span.close, base))
            .filter(|close| low <= close.start && close.end <= high)
            .map(|close| close.end)
            .max()
            .unwrap_or(low)
    }

    /// Delimiters that close (or, `reopen`, reopen) inline spans open across a
    /// source point where a line is split.
    fn straddling(&self, at: usize, reopen: bool) -> String {
        let rows = &self.projection.rows;
        let (row, base, _) = rows.at(rows.locate(at, false));
        let mut found: Vec<_> = row
            .spans
            .iter()
            .map(|span| (shift(&span.open, base), shift(&span.close, base)))
            .filter(|(open, close)| open.end <= at && at < close.start)
            .map(|(open, close)| if reopen { open } else { close })
            .collect();
        found.sort_by_key(|range| range.start);
        found
            .into_iter()
            .map(|range| self.source.byte_slice(range).to_string())
            .collect()
    }
}

/// Drops one trailing copied line ending and spells pasted endings like the
/// caret line, so a CRLF note stays CRLF.
fn normalize_paste(text: &str, newline: &str) -> String {
    let text = if text.len() > 1 || !matches!(text, "\n" | "\r") {
        text.strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .or_else(|| text.strip_suffix('\r'))
            .filter(|rest| !rest.is_empty())
            .unwrap_or(text)
    } else {
        text
    };
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str(newline);
            }
            '\n' => out.push_str(newline),
            c => out.push(c),
        }
    }
    out
}

/// Pasted lines after the first take `prefix`, or `blank` when empty.
fn prefixed(text: &str, newline: &str, prefix: &str, blank: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for (index, pasted) in text.split(newline).enumerate() {
        if index > 0 {
            out.push_str(newline);
            out.push_str(if pasted.is_empty() { blank } else { prefix });
        }
        out.push_str(pasted);
    }
    out
}

/// A block marker pasted alone goes in as its characters.
fn is_marker(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    let digits = text.trim_end_matches(['.', ')']);
    matches!(
        text,
        "-" | "*" | "+" | ">" | "- [ ]" | "- [x]" | "* [ ]" | "* [x]"
    ) || text.chars().all(|c| c == '#') && text.len() <= 6
        || digits.len() + 1 == text.len()
            && !digits.is_empty()
            && digits.len() <= 9
            && digits.bytes().all(|b| b.is_ascii_digit())
}

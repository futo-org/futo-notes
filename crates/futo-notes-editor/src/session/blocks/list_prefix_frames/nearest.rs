//! Nearest key/Outdent header spelling and canonical quote-prefix retirement.
use super::*;

struct NearestHeader {
    text: String,
    parallel: bool,
    newline: &'static str,
    copied: usize,
}

impl FrameAction {
    fn removed_quotes(
        self,
        prefix: &str,
        line: &crate::inline::blocks::ListCommandLine,
    ) -> Result<std::ops::Range<usize>, EditorError> {
        let list = line.list.as_ref().unwrap();
        let quote_end = super::indent_source::canonical_quote_end(prefix, line.quote_depth)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let quote_start = if self == FrameAction::Backspace {
            // Registered joinBackward merges through all quote barriers
            // after this header into its preceding empty paragraph.
            list.indent
        } else {
            let previous = super::indent_source::canonical_quote_end(prefix, line.quote_depth - 1)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let mut at = previous;
            while prefix.as_bytes().get(at) != Some(&b'>') {
                crate::inline::visit_container();
                if at >= quote_end {
                    return Err(EditorError::UnrepresentableFormat);
                }
                at += 1;
            }
            crate::inline::visit_container();
            at
        };
        Ok(quote_start..quote_end)
    }
}

impl EditorSession {
    fn protect_new_empty_header(
        &self,
        output: &mut String,
        prefix: &str,
        line: &crate::inline::blocks::ListCommandLine,
        quote_start: usize,
    ) -> Result<usize, EditorError> {
        let list = line.list.as_ref().unwrap();
        let marker = self.source.byte(list.marker.start);
        crate::inline::visit_container();
        if matches!(marker, b'-' | b'*') && list.ordinal.is_none() {
            let scope = super::indent_source::canonical_quote_end(prefix, list.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let mut count = 0;
            let mut thematic = true;
            for byte in prefix[scope..quote_start].bytes() {
                crate::inline::visit_container();
                if byte == marker {
                    count += 1;
                } else if !matches!(byte, b' ' | b'\t') {
                    thematic = false;
                    break;
                }
            }
            if thematic && count >= 3 {
                let alternate = super::list_styles::independent_marker(false, Some(marker), None);
                let replacement = (alternate as char).to_string();
                let at = list.marker.start - line.source.start;
                output.replace_range(at..at + 1, &replacement);
                return Ok(replacement.len() + 1);
            }
        }
        Ok(0)
    }

    fn nearest_header(
        &self,
        line: &crate::inline::blocks::ListCommandLine,
        items: &[crate::inline::ListLine],
        action: FrameAction,
    ) -> Result<NearestHeader, EditorError> {
        let list = line.list.as_ref().unwrap();
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        let mut headers = Vec::new();
        for item in items {
            crate::inline::visit_container();
            if line.source.start <= item.marker.start
                && item.marker.start <= list.marker.start
                && item.item.start <= list.marker.start
                && list.marker.start < item.item.end
            {
                let start = item.marker.start - line.source.start;
                let end = item.indent;
                if start >= end || end > prefix.len() || item.checked.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                headers.push((start, end, item.content_column - item.marker_column));
            }
        }
        let quotes = action.removed_quotes(&prefix, line)?;
        let (quote_start, quote_end) = (quotes.start, quotes.end);
        let ending = self
            .source
            .byte_slice(line.content.end..line.source.end)
            .to_string();
        let newline = if ending.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let parallel = action == FrameAction::Outdent && line.quote_depth == list.quote_depth + 1;
        let mut output = String::new();
        let mut copied = prefix.len() + ending.len();
        output.push_str(&prefix[..quote_start]);
        copied += quote_start;
        if parallel {
            // A compact empty header made only of three or more identical
            // bullets would become a thematic break. Change only this newly
            // explicit empty frame's marker through the established policy.
            copied += self.protect_new_empty_header(&mut output, &prefix, line, quote_start)?;
            // Only the paragraph newly lifted beside the list's empty first
            // paragraph needs a physical frame. Existing implicit ancestors
            // keep their exact compact header spelling.
            output.push_str(newline);
            copied += newline.len();
            let mut at = 0;
            for &(start, end, columns) in &headers {
                crate::inline::visit_container();
                output.push_str(&prefix[at..start]);
                output.extend(std::iter::repeat_n(' ', columns));
                copied += start - at + columns;
                at = end;
            }
            output.push_str(&prefix[at..quote_start]);
            copied += quote_start - at;
        }
        output.push_str(&prefix[quote_end..]);
        copied += prefix.len() - quote_end;
        Ok(NearestHeader {
            text: output,
            parallel,
            newline,
            copied,
        })
    }

    fn strip_nearest_continuation_quotes(
        &self,
        line: &crate::inline::blocks::ListCommandLine,
        end: usize,
        action: FrameAction,
        edits: &mut Vec<(std::ops::Range<usize>, String)>,
    ) -> Result<usize, EditorError> {
        let list = line.list.as_ref().unwrap();
        let mut copied = 0;
        let mut at = line.source.end;
        while at < end {
            let physical = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if physical.source.end <= at
                || physical.source.end > end
                || physical.code
                || physical.quote_depth != line.quote_depth
                || !physical
                    .list
                    .as_ref()
                    .is_some_and(|owned| owned.item == list.item && owned.depth == list.depth)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let raw = self.source.byte_slice(physical.prefix.clone()).to_string();
            copied += raw.len();
            let physical_quotes = raw
                .bytes()
                .filter(|byte| {
                    crate::inline::visit_container();
                    *byte == b'>'
                })
                .count();
            if physical_quotes > line.quote_depth {
                return Err(EditorError::UnrepresentableFormat);
            }
            let removed = if action == FrameAction::Backspace {
                list.quote_depth + 1
            } else {
                line.quote_depth
            };
            if physical_quotes >= removed {
                let end = super::indent_source::canonical_quote_end(&raw, physical_quotes)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let previous = super::indent_source::canonical_quote_end(&raw, removed - 1)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let mut start = previous;
                while raw.as_bytes().get(start) != Some(&b'>') {
                    crate::inline::visit_container();
                    if start >= end {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    start += 1;
                }
                edits.push((
                    at + start - line.source.start..at + end - line.source.start,
                    String::new(),
                ));
            }
            at = physical.source.end;
        }
        Ok(copied)
    }

    pub(super) fn plan_nearest_prefix_frame<'a>(
        &self,
        line: &'a crate::inline::blocks::ListCommandLine,
        items: &[crate::inline::ListLine],
        paragraph: Option<std::ops::Range<usize>>,
        action: FrameAction,
    ) -> Result<Option<FramePlan<'a>>, EditorError> {
        let list = line.list.as_ref().unwrap();
        let NearestHeader {
            text: output,
            parallel,
            newline,
            mut copied,
        } = self.nearest_header(line, items, action)?;
        if let Some(paragraph) = paragraph {
            if action == FrameAction::Outdent && !parallel {
                return Ok(None);
            }
            let footprint = line.source.start..paragraph.end;
            let mut edits = vec![(0..(line.content.start - line.source.start), output.clone())];
            copied += output.len();
            copied +=
                self.strip_nearest_continuation_quotes(line, paragraph.end, action, &mut edits)?;
            return Ok(Some(FramePlan::Paragraph {
                footprint,
                edits,
                shape: HeaderShape::ParagraphList {
                    original: list,
                    quotes: if action == FrameAction::Backspace {
                        list.quote_depth
                    } else {
                        line.quote_depth - 1
                    },
                    first: !parallel,
                    body: line.content.start,
                    inserted_at: self.projection.display_at(line.content.start),
                    newline: if parallel { newline } else { "" },
                },
                copied,
            }));
        }
        Ok(Some(FramePlan::Prefix {
            footprint: line.source.start..line.content.start,
            text: output,
            shape: HeaderShape::List {
                original: list,
                quotes: if action == FrameAction::Backspace {
                    list.quote_depth
                } else {
                    line.quote_depth - 1
                },
                first: !parallel,
            },
            copied,
        }))
    }
}

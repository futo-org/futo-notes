//! Explicit physical frames for empty list parents sharing a quoted body.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FrameAction {
    Outdent,
    Backspace,
    Text,
}

impl EditorSession {
    pub(super) fn shared_prefix_frames(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        action: FrameAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.selected_list_lines(range);
        let [line] = lines.as_slice() else {
            return Ok(None);
        };
        let Some(list) = line.list.as_ref() else {
            return Ok(None);
        };
        // Nearest paragraph framing owns only canonical physical body rows;
        // other item blocks and full-toolbar lifting retain their own paths.
        if line.content.is_empty()
            || line.code
            || line.heading != 0
            || list.checked.is_some()
            || !list.first
            || line.quote_depth == 0
            || (action != FrameAction::Text && line.quote_depth <= list.quote_depth)
            || (action == FrameAction::Backspace
                && (range.start != range.end
                    || range.start.0 != self.projection.display_at(line.content.start)))
        {
            return Ok(None);
        }
        let multiline = list.item.end > line.source.end;
        if action == FrameAction::Text && !multiline {
            return Ok(None);
        }
        if multiline && action != FrameAction::Text && list.depth != 1 {
            return Ok(None);
        }
        let (items, planning, _, paragraph) = self.projection.list_items_and_paragraph_at(
            &self.source,
            list.marker.start,
            multiline.then_some(line.content.start),
        );
        let paragraph = if multiline {
            let Some(paragraph) = paragraph.filter(|paragraph| {
                paragraph.start == line.content.start && paragraph.end > line.source.end
            }) else {
                return Ok(None);
            };
            Some(paragraph)
        } else {
            None
        };
        if action == FrameAction::Text {
            return self.full_multiline_prefix_frame(
                expected,
                range,
                line,
                &items,
                paragraph.unwrap(),
                planning,
                accept,
            );
        }
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        let mut headers = Vec::new();
        for item in &items {
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
        let quote_end = super::indent_source::canonical_quote_end(&prefix, line.quote_depth)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let quote_start = if action == FrameAction::Backspace {
            // Registered joinBackward merges through all quote barriers
            // after this header into its preceding empty paragraph.
            list.indent
        } else {
            let previous = super::indent_source::canonical_quote_end(&prefix, line.quote_depth - 1)
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
        let ending = self
            .source
            .byte_slice(line.content.end..line.source.end)
            .to_string();
        let newline = if ending.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        // This first multiline transition has a proven LF display insertion.
        // Other endings retain the existing flow until their literal plan is pinned.
        if multiline && newline != "\n" {
            return Ok(None);
        }
        let parallel = action == FrameAction::Outdent && line.quote_depth == list.quote_depth + 1;
        let mut output = String::new();
        let mut copied = planning + prefix.len() + ending.len();
        output.push_str(&prefix[..quote_start]);
        copied += quote_start;
        if parallel {
            // A compact empty header made only of three or more identical
            // bullets would become a thematic break. Change only this newly
            // explicit empty frame's marker through the established policy.
            let marker = self.source.byte(list.marker.start);
            crate::inline::visit_container();
            if matches!(marker, b'-' | b'*') && list.ordinal.is_none() {
                let scope = super::indent_source::canonical_quote_end(&prefix, list.quote_depth)
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
                    let alternate =
                        super::list_styles::independent_marker(false, Some(marker), None);
                    let replacement = (alternate as char).to_string();
                    let at = list.marker.start - line.source.start;
                    output.replace_range(at..at + 1, &replacement);
                    copied += replacement.len() + 1;
                }
            }
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
        if let Some(paragraph) = paragraph {
            if action == FrameAction::Outdent && !parallel {
                return Ok(None);
            }
            let footprint = line.source.start..paragraph.end;
            let mut edits = vec![(0..prefix.len(), output.clone())];
            copied += output.len();
            let mut at = line.source.end;
            while at < paragraph.end {
                let physical = self
                    .projection
                    .source_prefix_at(at)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                crate::inline::visit_container();
                if physical.source.end <= at
                    || physical.source.end > paragraph.end
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
                        at + start - footprint.start..at + end - footprint.start,
                        String::new(),
                    ));
                }
                at = physical.source.end;
            }
            let raw = self.source.byte_slice(footprint.clone()).to_string();
            let output = super::transaction::spell_edits(&raw, &edits)?;
            copied += raw.len() + output.len();
            let mut change = self.commit_planned_header(
                expected,
                range,
                footprint,
                &edits,
                &output,
                HeaderShape::ParagraphList {
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
                accept,
            )?;
            change.work.parsed_source_bytes += planning;
            change.work.materialized_source_bytes += copied;
            return Ok(Some(change));
        }
        let mut change = self.commit_planned_prefix(
            expected,
            range,
            line.source.start..line.content.start,
            &output,
            HeaderShape::List {
                original: list,
                quotes: if action == FrameAction::Backspace {
                    list.quote_depth
                } else {
                    line.quote_depth - 1
                },
                first: !parallel,
            },
            accept,
        )?;
        change.work.parsed_source_bytes += planning;
        change.work.materialized_source_bytes += copied;
        Ok(Some(change))
    }

    fn full_multiline_prefix_frame(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        line: &crate::inline::blocks::ListCommandLine,
        items: &[crate::inline::ListLine],
        paragraph: std::ops::Range<usize>,
        planning: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let list = line.list.as_ref().unwrap();
        let same_quote = list.depth == 2 && list.quote_depth == 0;
        let cross_quote = list.depth == 2 && list.quote_depth == 1;
        if line.quote_depth != 1
            || !(list.depth == 1 && list.quote_depth == 0 || same_quote || cross_quote)
            || list.item.end != paragraph.end
        {
            return Ok(None);
        }
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        let ending = self.source.byte_slice(line.content.end..line.source.end);
        if !ending.bytes().eq(b"\n".iter().copied()) {
            return Ok(None);
        }
        let mut shifts = std::collections::BTreeMap::new();
        let mut output = if same_quote {
            format!("{}\n\n", &prefix[..list.marker.start - line.source.start])
        } else {
            "\n".to_owned()
        };
        let mut at = 0;
        let mut root = None;
        for item in items {
            crate::inline::visit_container();
            if item.item.start <= list.marker.start && list.marker.start < item.item.end {
                if item.item.end != paragraph.end
                    || item.marker.start < line.source.start
                    || item.marker.start >= line.content.start
                    || item.checked.is_some()
                {
                    return Ok(None);
                }
                if item.depth == 1 {
                    root = Some(item);
                }
                let quote_end =
                    super::indent_source::canonical_quote_end(&prefix, item.quote_depth)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                let base = crate::inline::columns(&prefix[..quote_end], 0);
                shifts.insert(
                    item.quote_depth,
                    base as isize - item.content_column as isize,
                );
                if !same_quote || item.marker.start == list.marker.start {
                    let marker = item.marker.start - line.source.start;
                    if marker < at || item.indent > prefix.len() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    // Same-quote earlier empty list source was emitted above.
                    if !same_quote {
                        output.push_str(&prefix[at..marker]);
                    }
                    at = item.indent;
                }
            }
        }
        let Some(root) =
            root.filter(|root| root.quote_depth == 0 && root.marker.start == line.source.start)
        else {
            return Ok(None);
        };
        output.push_str(&prefix[at..]);
        let added = if same_quote { "\n\n" } else { "\n" };
        let footprint = line.source.start..paragraph.end;
        let mut copied = planning + prefix.len() + output.len();
        let mut edits = vec![(0..prefix.len(), output)];
        let mut at = line.source.end;
        while at < paragraph.end {
            let physical = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if physical.code
                || physical.quote_depth != 1
                || physical.source.end <= at
                || physical.source.end > paragraph.end
                || !physical
                    .list
                    .as_ref()
                    .is_some_and(|owned| owned.item == list.item && owned.depth == list.depth)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let old = self.source.byte_slice(physical.prefix.clone()).to_string();
            let moved =
                super::indent_source::shift_prefixes(&old, physical.quote_depth, &shifts, false)?;
            copied += old.len() + moved.len();
            edits.push((
                physical.prefix.start - footprint.start..physical.prefix.end - footprint.start,
                moved,
            ));
            at = physical.source.end;
        }
        let raw = self.source.byte_slice(footprint.clone()).to_string();
        let output = super::transaction::spell_edits(&raw, &edits)?;
        copied += raw.len() + output.len();
        let mut change = self.commit_planned_header(
            expected,
            range,
            footprint,
            &edits,
            &output,
            HeaderShape::ParagraphPlain {
                quotes: 1,
                earlier: same_quote.then_some((root.marker.start, root.ordinal)),
                body: line.content.start,
                inserted_at: self.projection.display_at(line.content.start),
                newline: added,
            },
            accept,
        )?;
        change.work.parsed_source_bytes += planning;
        change.work.materialized_source_bytes += copied;
        Ok(Some(change))
    }
}

#[cfg(test)]
#[path = "list_prefix_frames_work.rs"]
mod work_tests;

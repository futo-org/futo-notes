use super::*;

pub(crate) struct ParagraphUnit {
    pub source_lines: Range<usize>,
    pub display_lines: Range<usize>,
    pub source: Range<usize>,
    pub display: Range<usize>,
}

pub(crate) struct FenceSuffix {
    pub has_crlf: bool,
    pub closer: Range<usize>,
    pub frame_source: Range<usize>,
    pub frame_display: Range<usize>,
    pub units: Vec<ParagraphUnit>,
}

impl Projection {
    /// Canonical independent-row and real Rope line-index certificates are
    /// prepared before entering the bounded interface. No source snapshot.
    pub(crate) fn bounded_fence_suffix(
        &self,
        source: &Rope,
        code: &RetainedCode,
    ) -> (Option<FenceSuffix>, crate::BoundedWork) {
        let mut work = crate::BoundedWork::default();
        let index = self.rows.locate(code.body.start, false);
        let (row, base, display, visits) = self.rows.at_with_work(index);
        work.metadata_items += visits;
        if base != code.whole.start || code.language.as_ref().is_some_and(|text| text.len() > 16) {
            return (None, work);
        }
        let end = base + row.source_len;
        if end - code.body.end > 256 {
            return (None, work);
        }
        let after = source.byte_slice(code.whole.end..end).to_string();
        work.inspected_source_bytes += after.len();
        work.copied_bytes += after.len();
        if !after.chars().all(char::is_whitespace) {
            return (None, work);
        }
        let Some(fence) = row.blocks.iter().find_map(|block| {
            work.metadata_items += 1;
            block.fence.as_ref()
        }) else {
            return (None, work);
        };
        let Some(close) = fence.closer.as_ref() else {
            return (None, work);
        };
        let closer = base + close.start..base + close.end;
        let mut units = Vec::new();
        for next in index + 1..self.rows.len() {
            let (row, origin, shown, visits) = self.rows.at_with_work(next);
            work.metadata_items += visits + 1;
            if row.source_len == 0 {
                continue;
            }
            if row.source_len > 64
                || !row.definitions.is_empty()
                || !row.reference_uses.is_empty()
                || !row.guarded_words.is_empty()
                || !row.typed_inputs.is_empty()
                || !row.literal_links.is_empty()
                || !row.literal_delimiters.is_empty()
            {
                return (None, work);
            }
            for block in &row.blocks {
                work.metadata_items += 1;
                if block.code
                    || block.in_list
                    || block.list.is_some()
                    || block.quote_depth != 0
                    || block.heading != 0
                    || block.divider
                    || block.empty_comment
                    || block.fence.is_some()
                    || (!block.paragraph_text && !block.content.is_empty())
                {
                    return (None, work);
                }
            }
            for span in &row.spans {
                work.metadata_items += 1;
                if matches!(span.kind, row::SpanKind::Format(crate::InlineFormat::Code))
                    || matches!(&span.kind, row::SpanKind::Link(link) if link.reference.is_some())
                {
                    return (None, work);
                }
            }
            let source_lines =
                source.byte_to_line(origin)..source.byte_to_line(origin + row.source_len);
            let display_lines = self.display.byte_to_line(shown)
                ..self.display.byte_to_line(shown + row.display.len());
            if source_lines.len() != display_lines.len()
                || source.line_to_byte(source_lines.start) != origin
                || self.display.line_to_byte(display_lines.start) != shown
            {
                return (None, work);
            }
            units.push(ParagraphUnit {
                source_lines,
                display_lines,
                source: origin..origin + row.source_len,
                display: shown..shown + row.display.len(),
            });
            work.metadata_items += 1;
        }
        if units.is_empty() {
            return (None, work);
        }
        let mut previous = None;
        let mut has_crlf = false;
        for byte in source.byte_slice(code.body.start..).bytes() {
            work.inspected_source_bytes += 1;
            if previous == Some(b'\r') && byte == b'\n' {
                has_crlf = true;
                break;
            }
            previous = Some(byte);
        }
        (
            Some(FenceSuffix {
                has_crlf,
                closer,
                frame_source: code.body.end..end,
                frame_display: code.display.end..display + row.display.len(),
                units,
            }),
            work,
        )
    }
}

pub(crate) struct PlainPrefix {
    pub source_line: usize,
    pub display_line: usize,
}

impl Projection {
    /// Positive literal alphabet and one canonical text line, not a second
    /// Markdown planner. Punctuation/URI/reference candidates are unsupported.
    pub(crate) fn bounded_plain_prefix(
        &self,
        source: &Rope,
        code: &RetainedCode,
    ) -> (Option<PlainPrefix>, crate::BoundedWork) {
        let mut work = crate::BoundedWork::default();
        let index = self.rows.locate(code.whole.start, false);
        if index == 0 {
            return (None, work);
        }
        let (row, origin, shown, visits) = self.rows.at_with_work(index - 1);
        work.metadata_items += visits + 1;
        if origin + row.source_len != code.whole.start
            || row.source_len > 64
            || !row.spans.is_empty()
            || !row.definitions.is_empty()
            || !row.reference_uses.is_empty()
            || !row.guarded_words.is_empty()
            || !row.typed_inputs.is_empty()
            || !row.literal_links.is_empty()
            || !row.literal_delimiters.is_empty()
        {
            return (None, work);
        }
        let mut text = None;
        for block in &row.blocks {
            work.metadata_items += 1;
            if block.code
                || block.in_list
                || block.list.is_some()
                || block.quote_depth != 0
                || block.heading != 0
                || block.divider
                || block.empty_comment
            {
                return (None, work);
            }
            if !block.content.is_empty() {
                if text.is_some()
                    || !block.paragraph_text
                    || block.content.start != block.source.start
                {
                    return (None, work);
                }
                text = Some(block.content.clone());
            }
        }
        let Some(body) = text else {
            return (None, work);
        };
        for segment in &row.segments {
            work.metadata_items += 1;
            if !segment.identity {
                return (None, work);
            }
        }
        let mut word = false;
        for ch in source.byte_slice(origin..origin + row.source_len).chars() {
            work.inspected_source_bytes += ch.len_utf8();
            if ch.is_ascii_alphanumeric() {
                word = true;
            } else if !matches!(ch, ' ' | '\n') {
                return (None, work);
            }
        }
        if !word || source.byte_slice(origin + body.end..origin + body.end + 1) != "\n" {
            return (None, work);
        }
        let source_line = source.byte_to_line(origin + body.start);
        let display_line = self.display.byte_to_line(shown + body.start);
        if source.line_to_byte(source_line) != origin + body.start
            || self.display.line_to_byte(display_line) != shown + body.start
        {
            return (None, work);
        }
        (
            Some(PlainPrefix {
                source_line,
                display_line,
            }),
            work,
        )
    }
}

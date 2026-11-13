//! Copy and cut: exact source for a display selection.
use super::*;

impl EditorSession {
    /// Markdown for a display selection: exact source bytes, with whole lines
    /// carrying their block prefix and boundary-cut inline spans closed with
    /// their original delimiter spelling. Nested indentation of the first line
    /// is removed from every copied line.
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, EditorError> {
        on_next!(ref self, |e| e.copy_markdown(expected, range));
        self.check_revision(expected)?;
        self.validate_range(range)?;
        if range.start == range.end {
            return Ok(String::new());
        }
        let display = &self.projection.display;
        let whole_start = range.start.0 == line_start(display, range.start.0)
            && range.end.0 >= line_end(display, range.start.0);
        let whole_end = range.end.0 == line_end(display, range.end.0);
        let (_, tight_start) = self.projection.source_bounds(range.start.0);
        let (tight_end, wide_end) = self.projection.source_bounds(range.end.0);
        let physical = line_start(&self.source, tight_start);
        let start = if whole_start { physical } else { tight_start };
        let end = if whole_end { wide_end } else { tight_end };
        let indent = self
            .source
            .byte_slice(physical..tight_start.max(physical))
            .chars()
            .take_while(|c| matches!(c, ' ' | '\t'))
            .count();
        let mut body = self.source.byte_slice(start..end).to_string();
        if indent > 0 {
            body = dedent(&body, if whole_start { indent } else { 0 }, indent);
        }
        let skip = if whole_start {
            body.len() - body.trim_start_matches([' ', '\t', '>']).len()
        } else {
            body.len() - body.trim_start_matches([' ', '\t']).len()
        };
        let keep = if whole_end {
            body.len()
        } else {
            body.trim_end_matches([' ', '\t']).len().max(skip)
        };
        // Whitespace alone carries no format, so it gets no delimiters.
        let (openers, closers) = if skip < keep {
            self.cut_spans(start, end)
        } else {
            Default::default()
        };
        let mut out = String::with_capacity(body.len() + openers.len() + closers.len());
        out.push_str(&body[..skip]);
        out.push_str(&openers);
        out.push_str(&body[skip..keep]);
        out.push_str(&closers);
        out.push_str(&body[keep..]);
        Ok(out)
    }

    /// Copies the selection, then removes it as one isolated history action
    /// whose carried formats apply to the next typed character.
    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(String, Option<ViewChange>), EditorError> {
        on_next!(self, accept, |e, accept| e
            .cut_markdown(expected, range, accept));
        let copied = self.copy_markdown(expected, range)?;
        if copied.is_empty() {
            return Ok((copied, None));
        }
        let change =
            self.replace_action(expected, range, "", crate::InputAction::Isolated, accept)?;
        Ok((copied, Some(change)))
    }

    /// Opening and closing delimiters for spans that a copied source range cuts.
    fn cut_spans(&self, start: usize, end: usize) -> (String, String) {
        let mut openers: Vec<(usize, String)> = Vec::new();
        let mut closers: Vec<(usize, String)> = Vec::new();
        let rows = &self.projection.rows;
        let (row, base, _) = rows.at(rows.locate(start, false));
        for span in &row.spans {
            let (open, close) = (shift(&span.open, base), shift(&span.close, base));
            if open.end <= start && start <= close.start && close.start < end {
                openers.push((open.start, self.source.byte_slice(open.clone()).to_string()));
            }
        }
        let (row, base, _) = rows.at(rows.locate(end, false));
        for span in &row.spans {
            let (open, close) = (shift(&span.open, base), shift(&span.close, base));
            if open.end <= end && end <= close.start && open.start >= start {
                closers.push((
                    close.start,
                    self.source.byte_slice(close.clone()).to_string(),
                ));
            } else if open.end <= start && end <= close.start {
                openers.push((open.start, self.source.byte_slice(open.clone()).to_string()));
                closers.push((close.start, self.source.byte_slice(close).to_string()));
            }
        }
        openers.sort();
        openers.dedup();
        closers.sort();
        closers.dedup();
        (
            openers.into_iter().map(|(_, text)| text).collect(),
            closers.into_iter().map(|(_, text)| text).collect(),
        )
    }
}

/// Removes up to `later` leading spaces/tabs from each line after the first,
/// and up to `first` from the first line.
fn dedent(text: &str, first: usize, later: usize) -> String {
    let mut out = String::with_capacity(text.len());
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let limit = if index == 0 { first } else { later };
        let mut skipped = 0;
        let trimmed = line.trim_start_matches(|c: char| {
            let skip = skipped < limit && matches!(c, ' ' | '\t');
            skipped += usize::from(skip);
            skip
        });
        out.push_str(trimmed);
    }
    out
}

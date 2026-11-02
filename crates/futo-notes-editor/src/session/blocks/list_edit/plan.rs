//! Canonical respelling of changed rows; every other byte is kept.
use super::*;

pub(super) struct Plan {
    pub span: Range<usize>,
    pub text: String,
    /// New absolute start of every row's line and body.
    pub starts: Vec<(usize, usize)>,
    /// An escaped body's offset and length change.
    pub escapes: Vec<Option<(usize, isize)>>,
}

pub(super) struct Respelled {
    text: String,
    /// Length of the container prefix before the body.
    prefix: usize,
    escaped: Option<(usize, isize)>,
}

impl EditorSession {
    /// Respell changed rows and apply the repairs, keeping every other byte.
    pub(super) fn plan_rows(&self, rows: &[Row]) -> Result<Option<Plan>, EditorError> {
        let outputs = self.respell_rows(rows)?;
        self.emit_rows(rows, &outputs)
    }

    /// Each changed row's canonical prefix plus its (escaped) body; `None`
    /// keeps the row's exact bytes. Columns follow the emitted rows.
    fn respell_rows(&self, rows: &[Row]) -> Result<Vec<Option<Respelled>>, EditorError> {
        // Rows owning later rows keep their authored content column.
        let mut parents = vec![false; rows.len()];
        for row in rows.iter().filter(|row| !row.blank) {
            for &at in row.chain.iter().flatten() {
                if row.line.start > rows[at].line.start {
                    parents[at] = true;
                }
            }
        }
        let mut stack: Vec<usize> = Vec::new();
        let mut outputs = Vec::with_capacity(rows.len());
        for (index, row) in rows.iter().enumerate() {
            let depth = row.after.depth;
            let quotes_same = row.after.quotes == row.before.quotes;
            let context = match &row.list {
                _ if row.blank => true,
                Some(list) if depth > 0 && row.after.depth == row.before.depth => {
                    if row.after.opens {
                        depth == 1 || stack.get(depth - 2).copied() == list.parent_content_column
                    } else {
                        stack.get(depth - 1) == Some(&list.content_column)
                    }
                }
                _ => true,
            };
            if same_shape(&row.after, &row.before) && !row.forced && context && !row.escape {
                if depth > 0 && row.after.opens {
                    let list = row.list.as_ref().unwrap();
                    stack.truncate(depth - 1);
                    if stack.len() + 1 != depth {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    stack.push(list.content_column);
                } else if depth == 0 && !row.blank {
                    stack.clear();
                } else if depth > 0 {
                    stack.truncate(depth);
                }
                outputs.push(None);
                continue;
            }
            if row.fixed && row.list.is_none() && !row.escape && only_quotes(row) {
                outputs.push(Some(self.requote_lines(row)));
                continue;
            }
            if row.fixed || row.divider && depth != row.before.depth {
                return Err(EditorError::UnrepresentableFormat);
            }
            let (mut prefix, base) = if quotes_same {
                let quote = self
                    .source
                    .byte_slice(row.line.start..row.quote_end)
                    .to_string();
                let base = crate::inline::columns(&quote, 0);
                (quote, base)
            } else {
                ("> ".repeat(row.after.quotes), 2 * row.after.quotes)
            };
            if row.blank {
                // A blank row keeps only its quote markers.
            } else if depth > 0 {
                if row.after.opens {
                    self.opener_prefix(row, parents[index], base, &mut stack, &mut prefix)?;
                } else {
                    stack.truncate(depth);
                    let column = *stack
                        .get(depth - 1)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    prefix.push_str(&" ".repeat(column.saturating_sub(base)));
                    prefix.push_str(&"> ".repeat(row.after.inner));
                }
            } else {
                stack.clear();
            }
            let mut body = self.source.byte_slice(row.body.clone()).to_string();
            let mut escaped = None;
            if row.escape {
                let (at, removed, inserted) =
                    escape(&body).ok_or(EditorError::UnrepresentableFormat)?;
                body.replace_range(at..at + removed, &inserted);
                escaped = Some((at, inserted.len() as isize - removed as isize));
            }
            let length = prefix.len();
            prefix.push_str(&body);
            outputs.push(Some(Respelled {
                text: prefix,
                prefix: length,
                escaped,
            }));
        }
        Ok(outputs)
    }

    /// Marker and padding of a respelled opening row. An item kept at its
    /// level keeps its authored content column, so its descendants keep their
    /// bytes; otherwise one space follows the canonical marker.
    fn opener_prefix(
        &self,
        row: &Row,
        owns_rows: bool,
        base: usize,
        stack: &mut Vec<usize>,
        prefix: &mut String,
    ) -> Result<(), EditorError> {
        let depth = row.after.depth;
        let column = if depth == 1 {
            stack.clear();
            base
        } else {
            stack.truncate(depth - 1);
            *stack
                .get(depth - 2)
                .ok_or(EditorError::UnrepresentableFormat)?
        };
        if stack.len() + 1 != depth || column < base {
            return Err(EditorError::UnrepresentableFormat);
        }
        let marker = if row.after.ordered() {
            let number = row
                .after
                .ordinal
                .ok_or(EditorError::UnrepresentableFormat)?;
            format!(
                "{}{}",
                super::lists::physical_number(number),
                row.after.marker as char
            )
        } else {
            (row.after.marker as char).to_string()
        };
        prefix.push_str(&" ".repeat(column - base));
        prefix.push_str(&marker);
        let content = column + marker.len();
        let authored = row
            .list
            .as_ref()
            .filter(|list| {
                owns_rows
                    && row.before.opens
                    && depth == row.before.depth
                    && list.marker_column == column
            })
            .map_or(content + 1, |list| list.content_column);
        let padding = if (content + 1..=content + 4).contains(&authored) {
            authored - content
        } else {
            1
        };
        prefix.push_str(&" ".repeat(padding));
        stack.push(content + padding);
        match row.after.checked {
            Some(true) => prefix.push_str("[x] "),
            Some(false) => prefix.push_str("[ ] "),
            None => {}
        }
        Ok(())
    }

    fn emit_rows(
        &self,
        rows: &[Row],
        outputs: &[Option<Respelled>],
    ) -> Result<Option<Plan>, EditorError> {
        let Some(first) = rows
            .iter()
            .zip(outputs)
            .position(|(row, out)| out.is_some() || row.insert != Insert::None)
        else {
            return Ok(None);
        };
        let last = rows
            .iter()
            .zip(outputs)
            .rposition(|(row, out)| out.is_some() || row.insert != Insert::None)
            .unwrap();
        let span = rows[first].line.start..rows[last].end;
        let mut text = String::new();
        let mut starts = Vec::with_capacity(rows.len());
        let mut escapes = vec![None; rows.len()];
        let mut cursor = span.start;
        for (index, row) in rows.iter().enumerate() {
            if index < first || index > last {
                let shift = if index < first {
                    0
                } else {
                    (span.start + text.len()) as isize - span.end as isize
                };
                let at = |offset: usize| (offset as isize + shift) as usize;
                starts.push((at(row.line.start), at(row.body.start)));
                continue;
            }
            text.push_str(&self.source.byte_slice(cursor..row.line.start).to_string());
            if row.insert != Insert::None {
                let quote = self
                    .source
                    .byte_slice(row.line.start..row.quote_end)
                    .to_string();
                let quote = if row.after.quotes == row.before.quotes {
                    quote
                } else {
                    "> ".repeat(row.after.quotes)
                };
                let line_ending = self.inserted_ending(rows, row);
                if row.insert == Insert::Comment {
                    text.push_str(&quote);
                    text.push_str("<!-- -->");
                } else {
                    text.push_str(quote.trim_end());
                }
                text.push_str(&line_ending);
            }
            let line = span.start + text.len();
            match &outputs[index] {
                Some(output) => {
                    starts.push((line, line + output.prefix));
                    escapes[index] = output.escaped;
                    text.push_str(&output.text);
                    text.push_str(&self.source.byte_slice(row.line.end..row.end).to_string());
                }
                None => {
                    starts.push((line, line + row.body.start - row.line.start));
                    text.push_str(&self.source.byte_slice(row.line.start..row.end).to_string());
                }
            }
            cursor = row.end;
        }
        Ok(Some(Plan {
            span,
            text,
            starts,
            escapes,
        }))
    }

    /// An inserted line takes the row's own ending, else the note's style.
    pub(super) fn inserted_ending(&self, rows: &[Row], row: &Row) -> String {
        let row = if row.end > row.line.end {
            Some(row)
        } else {
            rows.iter().find(|row| row.end > row.line.end)
        };
        row.map_or("\n".to_owned(), |row| {
            self.source.byte_slice(row.line.end..row.end).to_string()
        })
    }

    /// A multi-line block (setext heading, hard-broken paragraph) that changes
    /// only its quote depth respells every physical line's quote prefix.
    fn requote_lines(&self, row: &Row) -> Respelled {
        let text = self.source.byte_slice(row.line.clone()).to_string();
        let quote = "> ".repeat(row.after.quotes);
        let mut out = String::new();
        let mut first = None;
        for line in text.split_inclusive('\n') {
            let end = super::super::indent_source::quote_prefix_end(line, row.before.quotes);
            out.push_str(&quote);
            first.get_or_insert(out.len());
            out.push_str(&line[end..]);
        }
        let prefix = first.unwrap_or(0);
        let later = text
            .find('\n')
            .map_or(row.body.len(), |at| at + row.line.start - row.body.start);
        Respelled {
            escaped: Some((
                later,
                (out.len() - prefix) as isize - row.body.len() as isize,
            )),
            text: out,
            prefix,
        }
    }
}

fn only_quotes(row: &Row) -> bool {
    row.after.quotes != row.before.quotes
        && Shape {
            quotes: 0,
            ..row.after.clone()
        } == Shape {
            quotes: 0,
            ..row.before.clone()
        }
}

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
    pub(super) fn plan_rows(
        &self,
        rows: &[Row],
        outer: &[usize],
    ) -> Result<Option<Plan>, EditorError> {
        let outputs = self.respell_rows(rows, outer)?;
        self.emit_rows(rows, &outputs)
    }

    /// Each changed row's canonical prefix plus its (escaped) body; `None`
    /// keeps the row's exact bytes. Columns follow the emitted rows.
    fn respell_rows(
        &self,
        rows: &[Row],
        outer: &[usize],
    ) -> Result<Vec<Option<Respelled>>, EditorError> {
        // Rows owning later rows keep their authored content column.
        let mut parents = vec![false; rows.len()];
        for row in rows.iter().filter(|row| !row.blank) {
            for &at in row.chain.iter().flatten() {
                if row.line.start > rows[at].line.start {
                    parents[at] = true;
                }
            }
        }
        let siblings = sibling_columns(rows);
        let mut stack: Vec<usize> = outer.to_vec();
        let mut outputs = Vec::with_capacity(rows.len());
        for (index, row) in rows.iter().enumerate() {
            let depth = row.after.depth;
            let quotes_same = row.after.quotes == row.before.quotes;
            // A row the command leaves alone, under ancestors it leaves
            // alone, keeps its bytes and columns whatever the rows above it
            // spelled; two items opening on its line hide a column it keeps.
            let settled = !row.changed()
                && !row.escape
                && row.chain.iter().flatten().all(|&at| !rows[at].changed());
            let context = settled
                || match &row.list {
                    _ if row.blank => true,
                    Some(list) if depth > 0 && row.after.depth == row.before.depth => {
                        if row.after.opens {
                            depth == 1
                                || stack.get(depth - 2).copied() == list.parent_content_column
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
                    if stack.len() + 1 != depth && !settled {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    while stack.len() + 1 < depth {
                        stack.push(list.parent_content_column.unwrap_or_default());
                    }
                    stack.push(list.content_column);
                } else if depth == 0 && !row.blank {
                    stack.clear();
                } else if depth > 0 {
                    stack.truncate(depth);
                }
                outputs.push(self.renumbered(row, parents[index]));
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
                    let owns = parents[index];
                    self.opener_prefix(row, owns, &siblings, base, &mut stack, &mut prefix)?;
                } else {
                    stack.truncate(depth);
                    let column = *stack
                        .get(depth - 1)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    push_indent(&mut prefix, base, column, row.tabs);
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
            // A lifted empty item's body excludes its final heading marker;
            // author that marker as prefix so source-selection mapping hides it.
            if row.after.heading > 0 && row.body.is_empty() {
                prefix.push_str(&"#".repeat(row.after.heading as usize));
                prefix.push(' ');
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
        siblings: &[(usize, usize, usize)],
        base: usize,
        stack: &mut Vec<usize>,
        prefix: &mut String,
    ) -> Result<(), EditorError> {
        let depth = row.after.depth;
        let parent = if depth == 1 {
            stack.clear();
            base
        } else {
            stack.truncate(depth - 1);
            *stack
                .get(depth - 2)
                .ok_or(EditorError::UnrepresentableFormat)?
        };
        // An item joining a list keeps its first unchanged sibling's marker
        // column (a tab-spelled one nests at the tab stop in its parent's
        // window, as a new sub-list does); a different column would nest it
        // under that sibling or swallow it.
        let pinned = siblings
            .iter()
            .find(|&&(key, depth, _)| (key, depth) == (row.key, row.after.depth))
            .map(|&(.., column)| column)
            .filter(|column| (parent..=parent + 3).contains(column));
        let column = pinned.unwrap_or(if row.tabs && depth > 1 {
            parent.next_multiple_of(TAB_STOP)
        } else {
            parent
        });
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
        push_indent(prefix, base, column, row.tabs);
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

    /// A kept ordered item whose number was its ordinal, renumbered with
    /// its list: only the digits change. Lazy numbers stay as written, and
    /// so do digits whose new width would move the content column of rows
    /// the item owns.
    fn renumbered(&self, row: &Row, owns_rows: bool) -> Option<Respelled> {
        let (Some(old), Some(new)) = (row.before.ordinal, row.after.ordinal) else {
            return None;
        };
        let list = row.list.as_ref()?;
        if old == new || !row.before.opens || !row.after.opens {
            return None;
        }
        let digits = list.marker.start..list.marker.end - 1;
        let physical = self.source.byte_slice(digits.clone()).to_string();
        if physical.parse::<u64>().ok()? != old {
            return None;
        }
        let line = self.source.byte_slice(row.line.clone()).to_string();
        let at = digits.start - row.line.start;
        let number = super::lists::physical_number(new).to_string();
        if owns_rows && number.len() != digits.len() {
            return None;
        }
        let text = format!("{}{number}{}", &line[..at], &line[at + digits.len()..]);
        Some(Respelled {
            prefix: row.body.start - row.line.start + number.len() - digits.len(),
            text,
            escaped: None,
        })
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

/// For each intended list and depth, the marker column of its first
/// unchanged item: a respelled item joining that list keeps the column, so
/// its content column cannot swallow those items.
fn sibling_columns(rows: &[Row]) -> Vec<(usize, usize, usize)> {
    let mut siblings: Vec<(usize, usize, usize)> = Vec::new();
    for row in rows.iter().filter(|row| !row.changed() && row.before.opens) {
        if let Some(list) = &row.list {
            if !siblings
                .iter()
                .any(|&(key, depth, _)| (key, depth) == (row.key, row.after.depth))
            {
                siblings.push((row.key, row.after.depth, list.marker_column));
            }
        }
    }
    siblings
}

const TAB_STOP: usize = 4;

/// The whitespace from column `from` to column `to` after the quote markers:
/// a tab for each tab stop passed when `tabs`, spaces for the rest.
fn push_indent(prefix: &mut String, from: usize, to: usize, tabs: bool) {
    let mut at = from;
    while tabs && (at / TAB_STOP + 1) * TAB_STOP <= to {
        prefix.push('\t');
        at = (at / TAB_STOP + 1) * TAB_STOP;
    }
    prefix.push_str(&" ".repeat(to.saturating_sub(at)));
}

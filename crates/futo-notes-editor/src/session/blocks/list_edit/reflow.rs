//! Respelling the parts of a plan that are not one row's own prefix: a block's
//! later physical lines, and the closing fence of a code block left open.
use super::*;

impl EditorSession {
    /// A block's physical lines after the first, each with its old container
    /// prefix (quotes, list indentation, inner quotes) replaced by `later`:
    /// the new body, its length change, and where the first later line starts.
    pub(super) fn reflow(
        &self,
        row: &Row,
        body: &str,
        later: &str,
    ) -> Result<(String, isize, usize), EditorError> {
        let quotes = row.before.quotes;
        let mut out = String::new();
        let mut at = None;
        for (index, line) in body.split_inclusive('\n').enumerate() {
            if index == 0 {
                out.push_str(line);
                continue;
            }
            at.get_or_insert(out.len());
            let mut end = super::super::indent_source::quote_prefix_end(line, quotes);
            if row.before.depth > 0 {
                let list = row
                    .list
                    .as_ref()
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let column = crate::inline::columns(&line[..end], 0);
                let (next, partial) = skip_columns(line, end, column, list.content_column);
                if partial {
                    return Err(EditorError::UnrepresentableFormat);
                }
                end = next;
            }
            end += super::super::indent_source::quote_prefix_end(&line[end..], row.before.inner);
            out.push_str(later);
            out.push_str(&line[end..]);
        }
        let delta = out.len() as isize - body.len() as isize;
        Ok((out, delta, at.unwrap_or(0)))
    }

    /// The fence characters that close the code block ending right above row
    /// `index`, when that block is still open there.
    pub(super) fn open_fence(&self, rows: &[Row], index: usize) -> Option<String> {
        let start = (0..index).rev().take_while(|&at| rows[at].code).last()?;
        let mut open: Option<(char, usize)> = None;
        for row in &rows[start..index] {
            let body = self.source.byte_slice(row.body.clone()).to_string();
            let text = body.trim();
            let fence = text.chars().next().filter(|ch| matches!(ch, '`' | '~'));
            let width = fence.map_or(0, |ch| text.chars().take_while(|&c| c == ch).count());
            open = match (open, fence) {
                (None, Some(ch)) if width >= 3 => Some((ch, width)),
                (Some((ch, opened)), Some(found))
                    if found == ch && width >= opened && text.chars().all(|c| c == ch) =>
                {
                    None
                }
                (open, _) => open,
            };
        }
        open.map(|(ch, width)| ch.to_string().repeat(width))
    }
}

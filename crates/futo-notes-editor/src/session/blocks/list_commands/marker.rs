use super::*;
use crate::inline::blocks::ListCommandLine;

impl EditorSession {
    pub(super) fn list_retained_prefix(
        &self,
        line: &ListCommandLine,
        prefix: &str,
        remove: bool,
        target_quote: usize,
    ) -> usize {
        if let Some(list) = line
            .list
            .as_ref()
            .filter(|list| !remove || list.first && list.quote_depth < line.quote_depth)
        {
            list.marker.start - line.source.start
        } else if !remove {
            super::super::indent_source::canonical_quote_end(prefix, target_quote).unwrap_or(0)
        } else {
            prefix.rfind('>').map_or(0, |at| {
                at + 1 + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')))
            })
        }
    }

    /// A quote after this header was the empty list item's child block.
    /// Lifting the item retains that empty paragraph and the inner quote.
    pub(super) fn lift_same_line_quote_prefix(
        &self,
        line: &ListCommandLine,
        prefix: &str,
        remove: bool,
    ) -> Result<Option<String>, EditorError> {
        let Some(list) = line
            .list
            .as_ref()
            .filter(|list| remove && list.first && list.quote_depth < line.quote_depth)
        else {
            return Ok(None);
        };
        crate::inline::visit_container();
        let outer = &prefix[..list.marker.start - line.source.start];
        let inner = &prefix[list.indent..];
        let end = super::super::indent_source::canonical_quote_end(
            inner,
            line.quote_depth - list.quote_depth,
        )
        .ok_or(EditorError::UnrepresentableFormat)?;
        let ending = line.source.end;
        crate::inline::visit_container();
        let newline = if ending >= 2
            && self.source.byte(ending - 2) == b'\r'
            && self.source.byte(ending - 1) == b'\n'
        {
            "\r\n"
        } else {
            "\n"
        };
        Ok(Some(format!("{}{newline}{outer}{}", outer, &inner[..end])))
    }

    pub(super) fn list_command_marker(
        &self,
        line: &ListCommandLine,
        command: BlockCommand,
        prefix: &str,
        retained: usize,
        style: (u8, u64, bool),
    ) -> String {
        let (marker_style, ordered_number, ordered_head) = style;
        match command {
            BlockCommand::OrderedList
                if line
                    .list
                    .as_ref()
                    .is_some_and(|list| list.ordinal.is_some()) =>
            {
                // Task state is independent of the existing ordered
                // marker. Retain lazy physical numbers and tab padding.
                let end = line
                    .task
                    .as_ref()
                    .map_or(prefix.len(), |task| task.start - line.source.start);
                let list = line.list.as_ref().unwrap();
                if ordered_head && list.ordinal != Some(ordered_number) {
                    format!(
                        "{}{}",
                        super::super::lists::physical_number(ordered_number),
                        &prefix[list.marker.end - 1 - line.source.start..end]
                    )
                } else {
                    prefix[retained..end].to_owned()
                }
            }
            BlockCommand::OrderedList => format!(
                "{}{} ",
                super::super::lists::physical_number(ordered_number),
                marker_style as char
            ),
            BlockCommand::TaskList => {
                let checked = line
                    .task
                    .as_ref()
                    .map(|task| {
                        self.source
                            .byte_slice(task.start + 1..task.start + 2)
                            .to_string()
                    })
                    .unwrap_or_else(|| " ".into());
                format!("{} [{checked}] ", marker_style as char)
            }
            _ => format!("{} ", marker_style as char),
        }
    }
}

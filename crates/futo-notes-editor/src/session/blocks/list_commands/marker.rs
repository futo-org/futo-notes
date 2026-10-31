use super::*;
use crate::inline::blocks::ListCommandLine;

impl EditorSession {
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

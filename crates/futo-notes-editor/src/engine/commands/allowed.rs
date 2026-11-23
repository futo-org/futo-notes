//! Which toolbar commands would act at the selection, each by its command's
//! own rule: a block command by the lines it would change, a format toggle
//! or Link by building it a line at a time until one line changes.
use super::super::command::Command;
use super::super::Engine;
use crate::{EditorError, InlineFormat, ToolbarCommand};

/// What the toolbar reads of the selection.
pub(crate) struct ToolbarFacts {
    pub formats: Vec<InlineFormat>,
    pub heading: Option<u8>,
    pub quote: bool,
    pub allowed: Vec<ToolbarCommand>,
}

impl Engine {
    /// The toolbar's formats, heading and quote, and the commands that would
    /// act at the selection now, in `ToolbarCommand` order. Block commands
    /// read the selection's body part, as `block_command` does.
    pub(crate) fn toolbar_facts(&self) -> ToolbarFacts {
        let (formats, mut allowed) = self.inline_facts();
        let body = self.in_body(self.selection);
        let (heading, quote, headings_act) = self.toolbar_blocks(body);
        if headings_act {
            allowed.extend([ToolbarCommand::Heading, ToolbarCommand::Quote]);
        }
        // A list button changes every line it takes: its marker goes on or
        // comes off.
        if !self.list_targets(body).is_empty() {
            allowed.extend([
                ToolbarCommand::BulletList,
                ToolbarCommand::OrderedList,
                ToolbarCommand::TaskList,
            ]);
        }
        if self.code_block_acts(body) {
            allowed.push(ToolbarCommand::CodeBlock);
        }
        let (divider, table) = self.divider_and_table_act(body);
        if divider {
            allowed.push(ToolbarCommand::Divider);
        }
        if table {
            allowed.push(ToolbarCommand::Table);
        }
        if self.image_acts() {
            allowed.push(ToolbarCommand::Image);
        }
        ToolbarFacts {
            formats,
            heading,
            quote,
            allowed,
        }
    }

    /// Whether a built command would change the note's bytes.
    pub(super) fn changes_source(&self, built: Result<Option<Command>, EditorError>) -> bool {
        let Ok(Some(command)) = built else {
            return false;
        };
        command
            .edits
            .iter()
            .any(|edit| self.source_slice(edit.range.clone()) != edit.text)
    }
}

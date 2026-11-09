//! Read-only toolbar state, derived by the canonical editor owner.
use super::blocks::{all_quoted, common_heading};
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolbarList {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolbarState {
    pub formats: Vec<InlineFormat>,
    pub heading: Option<u8>,
    pub quote: bool,
    pub list: Option<ToolbarList>,
    pub code: bool,
    pub mixed: bool,
    pub inline_allowed: bool,
    pub can_indent: bool,
    pub can_outdent: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

impl EditorSession {
    /// Selection-wide formats and common blocks, plus the initial command
    /// eligibility rules. This reads retained attribution; it never stages edits.
    pub fn toolbar_state(&self) -> ToolbarState {
        self.toolbar_state_at(self.selection)
    }

    /// Toolbar state for a supplied range, so a key acts exactly where its
    /// matching button would.
    pub(super) fn toolbar_state_at(&self, range: DisplayRange) -> ToolbarState {
        let lines = if range.start == range.end {
            self.projection.caret_block_lines(range)
        } else {
            self.projection.format_block_lines(range)
        };
        let first = lines.first();
        // Blank lines are aside from the selection-wide block state.
        let content = self.content_block_lines(&lines);
        let content_first = content.first().copied();
        let list_kind = |line: &crate::inline::blocks::BlockLine| {
            line.list.as_ref().map(|list| {
                if list.checked.is_some() {
                    ToolbarList::Task
                } else if list.ordinal.is_some() {
                    ToolbarList::Ordered
                } else {
                    ToolbarList::Bullet
                }
            })
        };
        let common = content_first.filter(|first| {
            content.iter().all(|line| {
                (line.heading, line.quote_depth, line.code, list_kind(line))
                    == (
                        first.heading,
                        first.quote_depth,
                        first.code,
                        list_kind(first),
                    )
            })
        });
        let code = !lines.is_empty() && lines.iter().all(|line| line.code);
        let same_fence = first.and_then(|line| line.fence.as_ref()).filter(|fence| {
            lines.iter().all(|line| {
                line.fence
                    .as_ref()
                    .is_some_and(|other| other.whole == fence.whole)
            })
        });
        // Items sharing a line with an item they sit in through a quote are
        // outside the generic list edit: neither command applies to them or
        // their quotes.
        let through_quote = first
            .and_then(|line| line.list.as_ref())
            .is_some_and(|list| list.through_quote);
        // An item whose own line opens a quote (`- > q`) is refused by both.
        let opens_quote = first.is_some_and(|line| {
            line.list
                .as_ref()
                .is_some_and(|list| list.first && line.quote_depth != list.quote_depth)
        });
        let can_indent = if lines.iter().any(|line| line.code) {
            same_fence.is_some()
        } else if opens_quote {
            false
        } else if let Some(line) = first.filter(|line| {
            line.list
                .as_ref()
                .is_some_and(|list| line.quote_depth == list.quote_depth)
        }) {
            line.list
                .as_ref()
                .is_some_and(|list| list.previous_content_column.is_some() && !through_quote)
        } else {
            !through_quote && lines.iter().any(|line| line.quote_depth > 0)
        };
        let can_outdent = if lines.iter().any(|line| line.code) {
            same_fence.is_some_and(|fence| {
                lines.iter().any(|line| {
                    fence.body.start <= line.source.start
                        && line.source.start < fence.body.end
                        && self.source.byte_slice(line.content.clone()).bytes().next() == Some(b' ')
                })
            })
        } else if opens_quote {
            false
        } else if let Some(line) = first.filter(|line| {
            line.list
                .as_ref()
                .is_some_and(|list| line.quote_depth == list.quote_depth)
        }) {
            let list = line.list.as_ref().unwrap();
            // Retiring a terminal empty root item with no line ending after it
            // cannot preserve an editable paragraph for its selected source
            // position; the command refuses.
            !(line.content.is_empty()
                && list.depth == 1
                && line.quote_depth == 0
                && line.source.end == self.source.len_bytes()
                && line.source.end == line.content.end)
                && !through_quote
        } else {
            !through_quote && lines.iter().any(|line| line.quote_depth > 0)
        };
        ToolbarState {
            formats: if range.start == range.end {
                self.active_formats()
            } else {
                self.selected_toggle_formats(range, &lines)
            },
            heading: common_heading(&content),
            quote: all_quoted(&content),
            list: content_first
                .and_then(list_kind)
                .filter(|kind| content.iter().all(|line| list_kind(line) == Some(*kind))),
            code,
            mixed: common.is_none(),
            inline_allowed: lines.iter().any(|line| !line.code && !line.metadata),
            can_indent,
            can_outdent,
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
        }
    }
}

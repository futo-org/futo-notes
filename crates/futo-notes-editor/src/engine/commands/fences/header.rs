//! A code block's header, written by a host's header fields: the opening
//! fence's language and `name:`. Only the info string changes; its other
//! keys, the fence characters and the indent stay. The fence line is hidden,
//! so no display offset moves and the selection stays where it was.
use super::super::super::code_block::CodeBlock;
use super::super::super::edit::Batch;
use super::super::super::history::Group;
use super::super::super::Engine;
use super::leading;
use crate::lines::fence_info::write_fence_info;
use crate::lines::{block, FenceRole, Kind};
use crate::{CodeBlockHeader, EditorError, Revision, SourceEdit, ViewChange};
use std::ops::Range;

/// An empty field clears its piece.
fn header_value(text: &str) -> Option<&str> {
    (!text.is_empty()).then_some(text)
}

impl Engine {
    /// Write `header` into its block's opening fence as one Undo step.
    /// `None` when the block already has these values (a language caret on
    /// it still becomes an ordinary caret). `InvalidText` when
    /// the line would not read back as an opening fence with exactly this
    /// language and name and the marks it had, and then nothing changes.
    pub(crate) fn set_code_block_header(
        &mut self,
        expected: Revision,
        header: &CodeBlockHeader,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        self.check_display(header.at.0)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let block = self
            .block_at(header.at.0)
            .ok_or(EditorError::InvalidRange)?;
        let language = header_value(&header.language);
        let name = header_value(&header.name);
        let fence_end = self.line_start(block.opener) + self.line(block.opener).body_len();
        if block.description.language.as_deref() == language
            && block.description.name.as_deref() == name
        {
            // No text changes, but a committed header still ends this
            // block's language caret, as a written one does.
            if self.pin == Some(fence_end) {
                self.pin = None;
            }
            return Ok(None);
        }
        let (range, info) = self.written_header(&block, language, name)?;
        let growth = info.len() as isize - range.len() as isize;
        let before = self.point();
        let mut batch = Batch::default();
        self.raw(&mut batch, range, &info);
        let Some((edit, shown, records)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        // A language caret on this block becomes an ordinary caret at the
        // start of its code; any other pin follows the text after the edit.
        self.pin = before.pin.filter(|&at| at != fence_end).map(|at| {
            if at > fence_end {
                at.saturating_add_signed(growth)
            } else {
                at
            }
        });
        self.typing = None;
        self.history.redo.clear();
        self.history.undo.push(Group {
            records,
            before,
            after: self.point(),
        });
        let change = self.change(edit, shown);
        Ok(Some(self.view(change)))
    }

    /// The source range of `block`'s info string and the info written over
    /// it, checked to read back through the line reader.
    fn written_header(
        &self,
        block: &CodeBlock,
        language: Option<&str>,
        name: Option<&str>,
    ) -> Result<(Range<usize>, String), EditorError> {
        let entry = self.line(block.opener);
        let Kind::Fence {
            indent: width,
            info: Some(old),
            ..
        } = &entry.line.kind
        else {
            unreachable!("an opening fence carries its info")
        };
        let body = entry.body();
        let indent = leading(body);
        let fence_character = body.as_bytes()[indent.len()];
        let fence_length = body[indent.len()..]
            .bytes()
            .take_while(|&byte| byte == fence_character)
            .count();
        let info_start = indent.len() + fence_length;
        // A backtick in a backtick fence's info string makes CommonMark read
        // the line as text, so other apps would not see the block.
        let unreadable = |value: &str| {
            value.chars().any(char::is_control) || (fence_character == b'`' && value.contains('`'))
        };
        if [language, name].into_iter().flatten().any(unreadable) {
            return Err(EditorError::InvalidText);
        }
        let info = write_fence_info(&body[info_start..], language, name);
        let line = format!("{}{info}{}", &body[..info_start], entry.ending());
        let mut carry = entry.carry.clone();
        let reads_back = match block::read_line(&mut carry, &line, 0).kind {
            Kind::Fence {
                role: FenceRole::Open,
                indent: new_width,
                info: Some(new),
            } => {
                new_width == *width
                    && carry.fence.as_ref().is_some_and(|fence| {
                        fence.ch == fence_character && fence.len == fence_length
                    })
                    && new.language.as_deref() == language
                    && new.name.as_deref() == name
                    && new.highlight == old.highlight
                    && new.lowlight == old.lowlight
            }
            _ => false,
        };
        if !reads_back {
            return Err(EditorError::InvalidText);
        }
        let start = self.line_start(block.opener);
        Ok((start + info_start..start + body.len(), info))
    }
}

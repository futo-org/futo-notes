use unicode_segmentation::{GraphemeCursor, GraphemeIncomplete};

use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, EditorSession, Revision,
    SelectionChange,
};

impl EditorSession {
    /// Move one extended grapheme in the requested direction, collapsing a
    /// nonempty selection to its corresponding edge without an extra step.
    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorError> {
        on_next!(self, |e| e.move_caret(expected, direction));
        self.check_revision(expected)?;
        let selection = self.selection();
        let position = match direction {
            CaretDirection::Backward => selection.start.0,
            CaretDirection::Forward => selection.end.0,
        };
        let position = self.grapheme_stop(position, direction, selection.start != selection.end)?;
        self.select_with_affinity(
            expected,
            DisplayRange {
                start: DisplayOffset(position),
                end: DisplayOffset(position),
            },
            match direction {
                CaretDirection::Forward => Affinity::Backward,
                CaretDirection::Backward => Affinity::Forward,
            },
        )
    }

    pub(crate) fn grapheme_stop(
        &self,
        position: usize,
        direction: CaretDirection,
        allow_current: bool,
    ) -> Result<usize, EditorError> {
        Self::grapheme_stop_in(&self.projection.display, position, direction, allow_current)
    }

    pub(crate) fn grapheme_stop_in(
        display: &ropey::Rope,
        position: usize,
        direction: CaretDirection,
        mut allow_current: bool,
    ) -> Result<usize, EditorError> {
        let length = display.len_bytes();
        if (direction == CaretDirection::Backward && position == 0)
            || (direction == CaretDirection::Forward && position == length)
        {
            return Ok(position);
        }
        let mut cursor = GraphemeCursor::new(position, length, true);
        let chunk_position = if direction == CaretDirection::Backward {
            position.saturating_sub(1)
        } else {
            position
        };
        let (mut chunk, mut chunk_start, _, _) = display.chunk_at_byte(chunk_position);
        loop {
            let result = if allow_current {
                match cursor.is_boundary(chunk, chunk_start) {
                    Ok(true) => return Ok(position),
                    Ok(false) => {
                        allow_current = false;
                        continue;
                    }
                    Err(error) => Err(error),
                }
            } else {
                match direction {
                    CaretDirection::Backward => cursor.prev_boundary(chunk, chunk_start),
                    CaretDirection::Forward => cursor.next_boundary(chunk, chunk_start),
                }
            };
            match result {
                Ok(boundary) => return Ok(boundary.unwrap_or(position)),
                Err(GraphemeIncomplete::PreContext(end)) => {
                    let (context, start, _, _) = display.chunk_at_byte(end - 1);
                    cursor.provide_context(&context[..end - start], start);
                }
                Err(GraphemeIncomplete::NextChunk) => {
                    (chunk, chunk_start, _, _) = display.chunk_at_byte(chunk_start + chunk.len());
                }
                Err(GraphemeIncomplete::PrevChunk) => {
                    (chunk, chunk_start, _, _) = display.chunk_at_byte(chunk_start - 1);
                }
                Err(GraphemeIncomplete::InvalidOffset) => return Err(EditorError::InvalidRange),
            }
        }
    }
}

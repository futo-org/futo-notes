//! Paired typing (`InputAction::PairedTyping`): what a typed backtick, `*`,
//! `~`, `[` or `]` does when the host opts in, and Backspace in an empty
//! pair. Each rule reads only the text around the caret, never what was
//! typed before it. `pairs.rs` lists the characters and their pairs:
//!
//! - at a caret (`caret.rs`), a pair with the caret between, one level more
//!   inside an empty pair; at a format's hidden closing marker or before a
//!   shown closing half, a step instead; after a line's lone ``` `` ```, a
//!   code block;
//! - over a selection (`selection.rs`), the character's next format level;
//! - in code, front matter, after an escaping `\` or where a pair would
//!   misread, the character as typed.
//!
//! Anything a rule cannot do is typed as plain typing types it. Backspace
//! removes one level of an empty pair the caret is between (`backspace.rs`).
mod backspace;
mod caret;
mod pairs;
mod selection;

use super::super::command::Command;
use super::super::edit::Change;
use super::super::Engine;
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, InputAction, Revision,
    SourceEdit,
};
use caret::CaretPairing;
use pairs::pair_key;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// One character typed under paired typing, at `range` of revision
/// `expected`.
#[derive(Clone, Copy)]
struct PairedInput<'a> {
    expected: Revision,
    range: DisplayRange,
    text: &'a str,
}

/// An odd run of backslashes ends at byte `end` of `text`: the next
/// character is escaped.
fn is_escaped_at(text: &str, end: usize) -> bool {
    let slashes = text[..end]
        .bytes()
        .rev()
        .take_while(|&byte| byte == b'\\')
        .count();
    slashes % 2 == 1
}

impl Engine {
    /// Input under `InputAction::PairedTyping`: one pair character follows
    /// the rules above; any other text, or input while text is marked, is
    /// plain typing. `None` when nothing changed, or when only the
    /// selection moved.
    pub(crate) fn paired_input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        let key = PairedInput {
            expected,
            range,
            text,
        };
        let Some(pair) = pair_key(text).filter(|_| self.composition.is_none()) else {
            return self.typed_paired_input(key, accept);
        };
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        if range.start != range.end {
            return self.paired_selection(key, &pair, accept);
        }
        let caret = self.outside_crlf(range);
        match self.caret_pairing(&pair, caret) {
            CaretPairing::CodeBlock(index) => {
                let command = self.lone_pair_block(index);
                self.paired_or_typed(key, accept, |_| Ok(Some(command)))
            }
            CaretPairing::Pair(pair) => {
                let Some(command) = self.pair_command(pair, caret) else {
                    return self.typed_paired_input(key, accept);
                };
                self.paired_or_typed(key, accept, |_| Ok(Some(command)))
            }
            CaretPairing::CrossMarker => {
                self.select_with_affinity(expected, range, Affinity::Forward)?;
                self.pin = None;
                Ok(None)
            }
            CaretPairing::StepOver => {
                let past =
                    DisplayOffset(self.grapheme_stop(range.start.0, CaretDirection::Forward));
                let caret = DisplayRange {
                    start: past,
                    end: past,
                };
                self.select_with_affinity(expected, caret, Affinity::Backward)?;
                self.pin = None;
                Ok(None)
            }
            CaretPairing::Stay => Ok(None),
            CaretPairing::Typed => self.typed_paired_input(key, accept),
        }
    }

    /// `key` typed as plain typing types it.
    fn typed_paired_input(
        &mut self,
        key: PairedInput,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        self.replace(
            key.expected,
            key.range,
            key.text,
            InputAction::Typing,
            accept,
        )
    }

    /// Run the command `build` makes as one action; when it refuses or
    /// changes nothing, type `key` instead.
    fn paired_or_typed(
        &mut self,
        key: PairedInput,
        accept: Accept,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
    ) -> Result<Option<Change>, EditorError> {
        match self.run(key.expected, build, accept) {
            Ok(Some(change)) => Ok(Some(change)),
            Ok(None) | Err(EditorError::UnrepresentableFormat) => {
                self.typed_paired_input(key, accept)
            }
            Err(error) => Err(error),
        }
    }
}

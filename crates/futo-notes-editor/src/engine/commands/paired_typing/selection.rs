//! A pair character typed over a selection: the selection takes the
//! character's next format level, or a backtick over lines makes a code
//! block.
use super::super::inline::FormatTurn;
use super::pairs::{Pair, PairKey};
use super::{Accept, PairedInput};
use crate::engine::edit::Change;
use crate::engine::Engine;
use crate::{BlockCommand, EditorError, InlineFormat};

/// The turns that take a selection reading as `formats` to `pair`'s next
/// selection level. `None` at the last level, and where the selection reads
/// as no level, so the character is typed over it.
fn next_level_turns(pair: &Pair, formats: &[InlineFormat]) -> Option<Vec<FormatTurn>> {
    let levels = pair.selection_levels;
    let mut own: Vec<InlineFormat> = levels
        .iter()
        .flat_map(|level| level.iter().copied())
        .collect();
    own.sort();
    own.dedup();
    let current = levels.iter().position(|level| {
        own.iter()
            .all(|format| level.contains(format) == formats.contains(format))
    })?;
    let next = levels.get(current + 1)?;
    let mut turns: Vec<FormatTurn> = own
        .iter()
        .filter(|format| next.contains(format) != formats.contains(format))
        .map(|&format| FormatTurn {
            format,
            on: next.contains(&format),
        })
        .collect();
    turns.sort_by_key(|turn| turn.on);
    Some(turns)
}

impl Engine {
    pub(super) fn paired_selection(
        &mut self,
        key: PairedInput,
        pair_key: &PairKey,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        if key.range != self.selection {
            self.select_with_affinity(key.expected, key.range, self.affinity)?;
        }
        let range = self.selection;
        let key = PairedInput { range, ..key };
        let PairKey::Open(pair) = pair_key else {
            return self.typed_paired_input(key, accept);
        };
        if self.touch(range).is_some() {
            return self.typed_paired_input(key, accept);
        }
        // Over a code block and other lines the Code block command changes
        // nothing, and so does its backtick: typing it over them would
        // delete the block for one character.
        if pair.is_backtick() && self.holds_code_block(self.lines_of(range)) {
            return Ok(None);
        }
        if pair.is_backtick() && self.lines_of(range).len() > 1 {
            return self.paired_or_typed(key, accept, |engine| {
                engine.fence_command(range, BlockCommand::CodeBlock)
            });
        }
        let Some(turns) = next_level_turns(pair, &self.range_formats(range)) else {
            return self.typed_paired_input(key, accept);
        };
        self.paired_or_typed(key, accept, |engine| engine.formats_turned(range, &turns))
    }
}

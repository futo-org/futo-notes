//! Paired typing (`InputAction::PairedTyping`): what a typed backtick does
//! when the host opts in. Each rule reads only the text around the caret,
//! never what was typed before it:
//!
//! - a backtick pair at a caret, the caret between them;
//! - over a backtick after the caret, a step past it (out of inline code at
//!   its end, where only the caret's side changes);
//! - after a line's lone ``` `` ``` (indented or not), a code block;
//! - over a selection, inline code on one line, a code block across lines;
//! - in code, front matter or after an escaping `\`, the backtick as typed.
//!
//! Anything a rule cannot do is typed as plain typing types it. Paired
//! Backspace (`ParagraphKey::PairedBackspace`) removes an empty pair the
//! caret is between, by the same reading of the text around it.
use super::super::command::{Command, Edit};
use super::super::edit::Change;
use super::super::{read, Engine};
use crate::lines::{Kind, SpanKind};
use crate::{
    Affinity, BlockCommand, CaretDirection, DisplayOffset, DisplayRange, EditorError, InlineFormat,
    InputAction, Revision, SourceEdit,
};

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// The one text paired typing acts on; other text is plain typing.
const BACKTICK: &str = "`";

/// What a backtick typed at a collapsed caret does.
enum CaretPairing {
    /// Line `index` is a lone pair the caret ends: it becomes a code block.
    CodeBlock(usize),
    /// A hidden code marker follows the caret: the caret takes its far side.
    CrossMarker,
    /// A shown backtick follows the caret: the caret moves past it.
    StepOver,
    /// Two backticks, the caret between them.
    Pair,
    Typed,
}

/// What a backtick typed over a selection does.
enum SelectionPairing {
    InlineCode,
    CodeBlock,
    Typed,
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
    /// Input under `InputAction::PairedTyping`: one typed backtick follows
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
        if text != BACKTICK || self.composition.is_some() {
            return self.replace(expected, range, text, InputAction::Typing, accept);
        }
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        if range.start != range.end {
            return self.paired_selection(expected, range, accept);
        }
        match self.caret_pairing(self.outside_crlf(range)) {
            CaretPairing::CodeBlock(index) => {
                let command = self.lone_pair_block(index);
                self.paired_or_typed(expected, range, accept, |_| Ok(Some(command)))
            }
            CaretPairing::Pair => {
                let Some(command) = self.pair_command(self.outside_crlf(range)) else {
                    return self.replace(expected, range, text, InputAction::Typing, accept);
                };
                self.paired_or_typed(expected, range, accept, |_| Ok(Some(command)))
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
            CaretPairing::Typed => self.replace(expected, range, text, InputAction::Typing, accept),
        }
    }

    fn paired_selection(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        if range != self.selection {
            self.select_with_affinity(expected, range, self.affinity)?;
        }
        let range = self.selection;
        match self.selection_pairing(range) {
            SelectionPairing::InlineCode => {
                self.paired_or_typed(expected, range, accept, |engine| {
                    engine.inline_code_on(range)
                })
            }
            SelectionPairing::CodeBlock => {
                self.paired_or_typed(expected, range, accept, |engine| {
                    engine.fence_command(range, BlockCommand::CodeBlock)
                })
            }
            SelectionPairing::Typed => {
                self.replace(expected, range, BACKTICK, InputAction::Typing, accept)
            }
        }
    }

    /// Run the command `build` makes as one action; when it refuses or
    /// changes nothing, type the backtick instead.
    fn paired_or_typed(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: Accept,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
    ) -> Result<Option<Change>, EditorError> {
        match self.run(expected, build, accept) {
            Ok(Some(change)) => Ok(Some(change)),
            Ok(None) | Err(EditorError::UnrepresentableFormat) => {
                self.replace(expected, range, BACKTICK, InputAction::Typing, accept)
            }
            Err(error) => Err(error),
        }
    }

    fn caret_pairing(&self, range: DisplayRange) -> CaretPairing {
        let at = self.input_at(range);
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        if matches!(entry.line.kind, Kind::Fence { .. } | Kind::FrontMatter(_)) {
            return CaretPairing::Typed;
        }
        let local = at - before.source;
        let body = entry.body();
        let lone_pair = matches!(entry.line.kind, Kind::Plain { .. })
            && entry.line.quote == 0
            && local == body.len()
            && body.trim_start_matches([' ', '\t']) == "``";
        if lone_pair {
            return CaretPairing::CodeBlock(index);
        }
        let shown_end = self.source_bounds(range.start.0).1;
        let code_spans = || {
            entry
                .spans
                .iter()
                .filter(|span| span.kind == SpanKind::Code)
        };
        if code_spans().any(|span| span.close.start == local || span.open.start == local) {
            if at < shown_end {
                return CaretPairing::CrossMarker;
            }
            return CaretPairing::Typed;
        }
        let in_code = code_spans().any(|span| span.open.end <= local && local <= span.close.start);
        let carries_code = self
            .formats
            .as_ref()
            .is_some_and(|formats| formats.contains(&InlineFormat::Code));
        if in_code || carries_code {
            return CaretPairing::Typed;
        }
        if body.as_bytes().get(local) == Some(&b'`') && at == shown_end {
            return CaretPairing::StepOver;
        }
        let opens_fence = entry.line.quote == 0 && {
            let leading = body[..local].trim_start_matches([' ', '\t']);
            !leading.is_empty() && leading.bytes().all(|byte| byte == b'`')
        };
        if is_escaped_at(body, local) || opens_fence {
            return CaretPairing::Typed;
        }
        CaretPairing::Pair
    }

    /// The display range of the empty backtick pair a collapsed caret is
    /// between: one backtick before it and one after, neither beside a
    /// further backtick, outside code, front matter and inline code, and
    /// not after an escaping `\`. `None` anywhere else, and while text is
    /// marked.
    pub(crate) fn empty_pair(&self, range: DisplayRange) -> Option<DisplayRange> {
        self.check_display_range(range).ok()?;
        if range.start != range.end || self.composition.is_some() {
            return None;
        }
        let at = self.input_at(self.outside_crlf(range));
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        if matches!(entry.line.kind, Kind::Fence { .. } | Kind::FrontMatter(_)) {
            return None;
        }
        let local = at - before.source;
        let body = entry.body();
        let is_backtick = |offset: usize| body.as_bytes().get(offset) == Some(&b'`');
        let pair = local >= 1
            && is_backtick(local - 1)
            && is_backtick(local)
            && !(local >= 2 && is_backtick(local - 2))
            && !is_backtick(local + 1);
        if !pair || is_escaped_at(body, local - 1) {
            return None;
        }
        let in_code = entry.spans.iter().any(|span| {
            span.kind == SpanKind::Code && span.open.start <= local && local - 1 < span.close.end
        });
        if in_code {
            return None;
        }
        Some(DisplayRange {
            start: DisplayOffset(self.display_of(at - 1)),
            end: DisplayOffset(self.display_of(at + 1)),
        })
    }

    fn selection_pairing(&self, range: DisplayRange) -> SelectionPairing {
        if self.touch(range).is_some() {
            return SelectionPairing::Typed;
        }
        if self.lines_of(range).len() > 1 {
            return SelectionPairing::CodeBlock;
        }
        SelectionPairing::InlineCode
    }

    /// Two backticks typed at the caret, as typing writes them, with the
    /// caret between them. `None` when typing would not leave the caret
    /// right after them.
    fn pair_command(&self, range: DisplayRange) -> Option<Command> {
        let plan = self.plan_input(range, "``", InputAction::Typing);
        let written = plan.caret.checked_sub(plan.range.start)?;
        if written < 2 || plan.inserted.get(written - 2..written) != Some("``") {
            return None;
        }
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let caret = plan.caret - 1;
        let mut command = Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            caret..caret,
        );
        command.typed = true;
        Some(command)
    }

    /// Line `index` (a lone pair after its indent) as an empty block: an
    /// opening fence and a closing fence at the same indent, which show as
    /// one empty code line; the caret at the opening fence's end, where
    /// letters write its language.
    fn lone_pair_block(&self, index: usize) -> Command {
        let start = self.line_start(index);
        let body = self.line(index).body();
        let indent = &body[..body.len() - "``".len()];
        let ending = self.empty_line_ending(index);
        let text = format!("{indent}```{ending}{indent}```");
        let caret = start + indent.len() + "```".len();
        let mut command = Command::new(
            vec![Edit::new(start..start + body.len(), text)],
            index..index + 1,
            caret..caret,
        );
        command.typed = true;
        command
    }
}

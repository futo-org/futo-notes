//! `Engine::run`: one command as one action behind the guard.
use super::super::edit::{Batch, Change, Marked};
use super::super::history::Group;
use super::super::Engine;
use super::{class, Command};
use crate::lines::Kind;
use crate::{DisplayRange, EditorError, InputAction, Revision, SourceEdit};

impl Engine {
    /// Run the command `build` makes from the engine's state, as one action
    /// behind the guard. Pending marked text commits first, in the same
    /// acceptance and as its own undo step, and `build` reads the note with
    /// it in place. `None` when nothing changed or the guard cancelled; a
    /// typed command that changed nothing still leaves its selection.
    pub(crate) fn run(
        &mut self,
        expected: Revision,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.run_removing(expected, None, build, accept)
    }

    /// `run`, with display range `removed` removed first, as typing removes
    /// it, after marked text commits: one acceptance and one undo step with
    /// the command, which `build` makes from the note without it. The
    /// removal stays when the command changes nothing or the guard cancels
    /// it. A range `removed_then_built` refuses changes nothing.
    pub(crate) fn run_removing(
        &mut self,
        expected: Revision,
        removed: Option<DisplayRange>,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        let opening = self.point();
        let marked = self.composition.take();
        let mut batch = Batch::default();
        let mut committed = None;
        if let Some(marked) = &marked {
            self.commit_marked(&mut batch, marked);
            committed = Some((batch.records.len(), self.point()));
        }
        let restore = |engine: &mut Self, batch: Batch| {
            engine.revert(batch);
            engine.restore(&opening);
            engine.composition = marked.clone();
        };
        let command = match self.removed_then_built(&mut batch, removed, build) {
            Ok(command) => command,
            Err(error) => {
                restore(self, batch);
                return Err(error);
            }
        };
        let mut applied = false;
        if let Some(command) = &command {
            match self.apply(&mut batch, command) {
                Ok(true) => applied = true,
                Ok(false) => {
                    // Cancelled: keep only the commit and the removal.
                    restore(self, batch);
                    if marked.is_none() && removed.is_none() {
                        return Ok(None);
                    }
                    self.composition = None;
                    batch = Batch::default();
                    if let Some(marked) = &marked {
                        self.commit_marked(&mut batch, marked);
                    }
                    if let Some(removed) = &removed {
                        self.remove_typed(&mut batch, removed);
                    }
                }
                Err(error) => {
                    restore(self, batch);
                    return Err(error);
                }
            }
        }
        let accepted = match self.accept(batch, accept) {
            Ok(accepted) => accepted,
            Err(error) => {
                self.restore(&opening);
                self.composition = marked;
                return Err(error);
            }
        };
        let Some((edit, shown, mut records)) = accepted else {
            // Typing's commands land even when they wrote the bytes already
            // there, as typing them over a selection does. Marked text that
            // committed unchanged still leaves the caret at its end.
            let typed = command.as_ref().filter(|command| applied && command.typed);
            if let (Some(command), None) = (typed, &committed) {
                self.restore(&opening);
                self.land(command.selection.clone(), command.affinity);
            } else if committed.is_none() || applied {
                self.restore(&opening);
            }
            return Ok(None);
        };
        self.typing = None;
        self.formats = None;
        self.history.redo.clear();
        let mut before = opening;
        if let Some((count, after_commit)) = committed {
            let rest = records.split_off(count);
            if records.iter().any(|r| r.removed != r.inserted) {
                self.history.undo.push(Group {
                    records,
                    before,
                    after: after_commit.clone(),
                });
                before = after_commit;
            }
            records = rest;
        }
        if let (true, Some(command)) = (applied, command) {
            self.land(command.selection.clone(), command.affinity);
            self.carry_deleted(command.carry);
            if command.selects_block {
                self.select_block_at(command.selection.start);
            }
        }
        if !records.is_empty() {
            self.history.undo.push(Group {
                records,
                before,
                after: self.point(),
            });
        }
        Ok(Some(self.change(edit, shown)))
    }

    /// `removed` removed into `batch` as typing removes it, then the command
    /// `build` makes; none, with nothing removed, when `removed` is not typed
    /// text on one line (across a line break, an image or a wikilink, or on
    /// a code line or in front matter).
    fn removed_then_built(
        &mut self,
        batch: &mut Batch,
        removed: Option<DisplayRange>,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
    ) -> Result<Option<Command>, EditorError> {
        let Some(range) = removed else {
            return build(self);
        };
        self.check_display_range(range)?;
        let source = self.source_selection(range);
        let index = self.line_of(source.start);
        let typed = index == self.line_of(source.end)
            && !self.touches_metadata(range)
            && !self.touches_atom(range)
            && !matches!(
                self.line(index).line.kind,
                Kind::Fence { .. } | Kind::FrontMatter(_)
            );
        if !typed {
            return Ok(None);
        }
        self.remove_typed(batch, &range);
        build(self)
    }

    fn remove_typed(&mut self, batch: &mut Batch, range: &DisplayRange) {
        let removal = self.plan_input(*range, "", InputAction::Typing);
        self.raw(batch, removal.range.clone(), &removal.inserted);
        self.caret_at(removal.caret);
    }

    /// Marked text written into `batch` as committing it writes it, the
    /// caret at its end.
    fn commit_marked(&mut self, batch: &mut Batch, marked: &Marked) {
        self.adopt_marked_caret(marked.range);
        let commit = self.plan_input(
            self.outside_crlf(marked.range),
            &marked.text,
            InputAction::CompositionCommit,
        );
        self.raw(batch, commit.range.clone(), &commit.inserted);
        self.caret_at(commit.caret);
    }

    /// Apply `command`'s edits to `batch`, then the guard. `false` when the
    /// guard fails, `InvalidText` when the image it writes does not read
    /// back (the edits stay in `batch` for the caller to revert).
    fn apply(&mut self, batch: &mut Batch, command: &Command) -> Result<bool, EditorError> {
        let mut edits = command.edits.clone();
        edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        for edit in &edits {
            if edit.range.start > edit.range.end {
                return Err(EditorError::InvalidRange);
            }
            self.check_source(edit.range.start)?;
            self.check_source(edit.range.end)?;
        }
        if edits
            .windows(2)
            .any(|pair| pair[0].range.end > pair[1].range.start)
        {
            return Err(EditorError::InvalidRange);
        }
        let before = if command.typed {
            None
        } else {
            Some(self.before_command(command, &edits)?)
        };
        let same_kind: Vec<_> = command
            .same_kind
            .iter()
            .map(|&(old, new)| (class(&self.store.get(old).line.kind), new))
            .collect();
        self.raw_edits(batch, &edits);
        if let Some(image) = &command.image {
            if !self.reads_as_image(image) {
                return Err(EditorError::InvalidText);
            }
        }
        let count = self.store.len();
        let kinds_kept = same_kind
            .iter()
            .all(|&(was, new)| new < count && class(&self.store.get(new).line.kind) == was);
        Ok(kinds_kept && before.is_none_or(|before| self.guard_holds(&before)))
    }
}

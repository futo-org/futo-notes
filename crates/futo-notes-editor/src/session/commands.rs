//! Tables, clipboard, links, images, tags, wikilinks and note ids: each hands
//! its work to the core's command family of the same name.
use super::{Accept, EditorSession};
use crate::{
    DisplayRange, EditorError, ImageClaim, LinkDescription, NoteIdChange, Revision,
    TableCommand, TableDescription, TableKey, TableOutcome, ViewChange, WikilinkCompletion,
};

impl EditorSession {
    /// Tab, Shift+Tab, Enter, Mod+Enter and Shift+Enter with the selection in a
    /// cell. `None` leaves the key to the ordinary paragraph path (outside a
    /// table, across cells, Shift+Tab in the first cell).
    pub fn table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
        accept: Accept,
    ) -> Result<Option<TableOutcome>, EditorError> {
        self.run(|e| e.press_table_key(expected, key, accept))
    }

    /// Structural command addressed by any range inside the target cell.
    /// `None`: not in a cell, or the command is disabled for it (header row
    /// deletion, a table's last body row or column).
    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.run_table_command(expected, range, command, accept))
    }

    /// Every table a line in `range` lies in, in order: what a host gets by
    /// asking `inspect_table` at each block start, in one call.
    pub fn inspect_tables(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorError> {
        self.engine.inspect_tables(expected, range)
    }

    /// The table at `range`, with its focused cell and applicable commands when
    /// the range lies inside one cell. Hosts pass the current selection.
    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, EditorError> {
        self.engine.inspect_table(expected, range)
    }

    /// Markdown for a display selection: exact source bytes, with whole lines
    /// carrying their block prefix and boundary-cut inline spans closed with
    /// their original delimiter spelling. Nested indentation of the first line
    /// is removed from every copied line.
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, EditorError> {
        self.engine.copy_markdown(expected, range)
    }

    /// Copies the selection, then removes it as one isolated history action
    /// whose carried formats apply to the next typed character.
    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: Accept,
    ) -> Result<(String, Option<ViewChange>), EditorError> {
        self.run(|e| e.cut_markdown(expected, range, accept))
    }

    /// Plain-text paste, written as given: line endings follow the caret line,
    /// one trailing copied line ending is dropped, and lines after the first
    /// take the caret line's containers. The paste is one isolated history
    /// action.
    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.paste_markdown(expected, range, text, accept))
    }

    /// Inspect the contiguous run containing the complete selection. A caret at
    /// a run boundary follows the session's explicit neighbor affinity.
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<LinkDescription>, EditorError> {
        self.engine.inspect_link(expected, range)
    }

    /// Set the selected link destination, expanding an interior selection to
    /// that complete contiguous run. Empty destinations unlink. An unchanged
    /// destination accepts no record and adds no history.
    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.set_link_view(expected, range, destination, accept))
    }

    /// Replace a label and destination atomically. Labels are literal display
    /// text; an interior range expands to the complete existing link.
    pub fn edit_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: &str,
        destination: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.edit_link_view(expected, range, label, destination, accept))
    }

    /// Begin an asynchronous insertion. Present the claim to `insert_image`;
    /// it stays valid across ordinary edits and expires with this session.
    pub fn image_claim(&self) -> ImageClaim {
        ImageClaim(self.incarnation)
    }

    /// Insert the stored vault image `reference` at the current caret (replacing
    /// a selection) as one isolated accepted edit, leaving the caret after the
    /// image. A claim issued for another session (another note, or this note
    /// reopened) is `StaleClaim`; an unwritable reference or alt is
    /// `InvalidText`. Inside code nothing is inserted (`None`).
    pub fn insert_image(
        &mut self,
        expected: Revision,
        claim: ImageClaim,
        reference: &str,
        alt: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if claim != self.image_claim() {
            return Err(EditorError::StaleClaim);
        }
        self.run(|e| e.insert_image(expected, reference, alt, accept))
    }

    /// Canonical tags (`#name`) of the body, in first-seen order. One on-demand
    /// scan; no edit calls it.
    pub fn tags(&self) -> Vec<String> {
        self.engine.tags()
    }

    /// Canonical tags of the leading header tag block.
    pub fn header_tags(&self) -> Vec<String> {
        self.engine.header_tags()
    }

    /// Add a tag to the header block, creating the block when absent. The tag
    /// is normalized; one already present (case-insensitively) changes nothing.
    pub fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.add_header_tag(expected, tag, accept))
    }

    /// Remove every spelling of a tag from the header block, keeping all other
    /// bytes. A line left without tags goes away; an emptied block also drops
    /// its blank separator.
    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.remove_header_tag(expected, tag, accept))
    }

    /// The open `[[` run at the caret and the notes it offers, or `None` when
    /// there is no run (a selection, code, an escaped bracket, a closed link,
    /// an open composition). Notes keep the delivered ranking.
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<WikilinkCompletion>, EditorError> {
        self.engine.wikilink_completion(expected)
    }

    /// Replace exactly the claimed run with `[[note_id]]` and put the caret after
    /// it, as one isolated accepted edit. The claim is the `range` and `query` a
    /// request returned. It is stale (`StaleRevision` after any edit,
    /// `StaleClaim` when the caret left the run, the run changed or the note
    /// is no longer in the delivered ids) and then nothing changes.
    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.run(|e| e.accept_wikilink_completion(expected, range, query, note_id, accept))
    }

    /// The note a tapped schemeless link destination names, among the delivered note ids, from
    /// the folder of `current_id`; `None` when it names no note.
    pub fn resolve_note_link(&self, current_id: &str, destination: &str) -> Option<String> {
        self.engine.resolve_note_link(current_id, destination)
    }

    /// The destination to save for what was typed in the link prompt of the note `current_id`: a
    /// destination naming an existing note stays a note link as typed; otherwise a web-looking
    /// address gains `https://`.
    pub fn normalize_link_destination(&self, current_id: &str, typed: &str) -> String {
        self.engine.normalize_link_destination(current_id, typed)
    }

    /// Install the vault's current note ids. Source, display, selection, history
    /// and any composition are untouched, so this is valid while composing. Work
    /// is proportional to the id list plus the lines holding a link whose last
    /// component matches a changed id; other lines are never visited.
    pub fn update_note_ids(&mut self, note_ids: &[String]) -> NoteIdChange {
        self.run(|e| e.update_note_ids(note_ids))
    }

    /// Replace the source with the store's rewritten bytes as one accepted
    /// edit and one Undo step. Existing history is untouched: older entries are
    /// reachable only after undoing this one restores the exact prior source.
    pub fn apply_own_relink(
        &mut self,
        expected: Revision,
        rewritten: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.apply_own_relink(expected, rewritten, accept))
    }
}

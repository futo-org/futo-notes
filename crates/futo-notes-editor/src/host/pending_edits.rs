/// One queued edit, in the coordinates of the text just before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Queued {
    start: usize,
    end: usize,
    inserted: usize,
}

/// Taps and selections a view takes while its note's engine session does not exist yet (the
/// first screens of a long note are shown before the whole open lands), mapped to where the
/// engine will hold them. Each is made against the text the user sees, which the keys before it
/// have not changed.
///
/// Keys are not mapped here: a host replays them at the engine's caret, in order, as the
/// user's own keys would have landed ([`DisplayMirror::at_caret`](super::DisplayMirror::at_caret)).
/// The host records what the engine actually changed ([`record`](Self::record)), then maps the
/// next tap through it ([`map`](Self::map)). A position before an edit stays; one at or after
/// its end moves by what the edit changed; one inside a replaced range goes to its start (a
/// range's end, to the end of the replacement; a caret stays a caret). Insertion affinity: a range's end that sits
/// where text was inserted stays before it (the Backspace of the character before an insertion
/// point must not swallow the insertion), while a start there, or a collapsed range, goes after
/// it (a second typed character lands after the first). Units are the host's (UTF-16).
///
/// The engine reports the smallest display change, which inside a run of identical characters is
/// its rightmost spelling ("a" typed at the start of "aa" is reported at the end). Which spelling
/// the user meant is not in the report, so [`record_near`](Self::record_near) takes the position the host
/// asked for and slides an engine-reported pure insertion or deletion to the nearest equivalent
/// spelling to it, within the run the mirror measured (`slack`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PendingEdits {
    queued: Vec<Queued>,
}

impl PendingEdits {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.queued.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queued.is_empty()
    }

    pub fn clear(&mut self) {
        self.queued.clear();
    }

    /// `[start, end)` of the text the user sees, as the engine will hold it when every queued
    /// edit has been applied.
    pub fn map(&self, start: usize, end: usize) -> (usize, usize) {
        let collapsed = start == end;
        let (mut start, mut end) = (start.min(end), start.max(end));
        for edit in &self.queued {
            start = moved(start, edit, false);
            end = moved(end, edit, true).max(start);
        }
        // A caret stays a caret: a tap at or inside a replacement is not a selection of it.
        (start, if collapsed { start } else { end })
    }

    /// Note an edit the engine made, in the coordinates of the text just before it, at the place
    /// it reports.
    pub fn record(&mut self, start: usize, end: usize, inserted: usize) {
        self.queued.push(Queued {
            start: start.min(end),
            end: start.max(end),
            inserted,
        });
    }

    /// Note an edit the engine made that the host asked for at `near` (the start of the range it
    /// replayed). `slack` is how many units earlier the same pure insertion or deletion could
    /// equally have been spelled ([`MirrorEdit::slack`](super::MirrorEdit::slack)); the edit is
    /// recorded at the spelling nearest `near`, so typing before a run of identical characters is
    /// recorded before it, not after. Any other edit, or `slack` of 0, is recorded as reported.
    pub fn record_near(
        &mut self,
        start: usize,
        end: usize,
        inserted: usize,
        slack: usize,
        near: usize,
    ) {
        let (start, end) = (start.min(end), start.max(end));
        let pure = start == end || inserted == 0;
        let slack = if pure { slack.min(start) } else { 0 };
        let shift = start - near.clamp(start - slack, start);
        self.record(start - shift, end - shift, inserted);
    }

    /// [`map`](Self::map) then [`record`](Self::record): an edit whose replacement length is
    /// known in advance. Returns the range to replay it on.
    pub fn push(&mut self, start: usize, end: usize, inserted: usize) -> (usize, usize) {
        let (start, end) = self.map(start, end);
        self.record(start, end, inserted);
        (start, end)
    }
}

fn moved(at: usize, edit: &Queued, is_end: bool) -> usize {
    if at < edit.start || (is_end && at == edit.start && edit.start == edit.end) {
        at
    } else if at >= edit.end {
        at - (edit.end - edit.start) + edit.inserted
    } else if is_end {
        edit.start + edit.inserted
    } else {
        edit.start
    }
}

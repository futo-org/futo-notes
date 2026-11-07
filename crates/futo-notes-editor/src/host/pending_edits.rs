/// One queued edit, in the coordinates of the text just before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Queued {
    start: usize,
    end: usize,
    inserted: usize,
}

/// Input a view takes while its note's engine session does not exist yet (the first screens of
/// a long note are shown before the whole open lands). Each op is made against the text the
/// user sees, which the ops before it have not changed; replayed in order against the engine,
/// its range must be where the earlier ones left that text. The host replays the ops one at a
/// time and records what the engine actually changed ([`record`](Self::record)), then maps the
/// next op's range through that ([`map`](Self::map)). A position before an edit stays; one at or
/// after its end moves by what the edit changed (so a second typed character lands after the
/// first); one inside a replaced range goes to its start (a range's end, to the end of the
/// replacement). Units are the host's (UTF-16).
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
        let (mut start, mut end) = (start.min(end), start.max(end));
        for edit in &self.queued {
            start = moved(start, edit, false);
            end = moved(end, edit, true).max(start);
        }
        (start, end)
    }

    /// Queue an edit made on the text the user sees: `[start, end)` replaced by `inserted`
    /// UTF-16 units. Returns the range to replay it on, in the engine's coordinates.
    /// Note an edit the engine made, in the coordinates of the text just before it.
    pub fn record(&mut self, start: usize, end: usize, inserted: usize) {
        self.queued.push(Queued {
            start: start.min(end),
            end: start.max(end),
            inserted,
        });
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
    if at < edit.start {
        at
    } else if at >= edit.end {
        at - (edit.end - edit.start) + edit.inserted
    } else if is_end {
        edit.start + edit.inserted
    } else {
        edit.start
    }
}

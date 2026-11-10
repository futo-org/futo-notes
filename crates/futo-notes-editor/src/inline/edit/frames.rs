//! Repairs for a replacement whose selection crosses a code block's frame.
//! Text after the selection joins the line the selection began on, as it does
//! across any block boundary, and the code lines left stay code. The planner
//! tries these only for input it refused without them, inside an input that
//! checks its whole result (`crate::inline::keeps_blocks`).
use super::{Piece, PieceOrigin};
use crate::inline::fences::Fence;
use crate::EditorError;
use std::ops::Range;

fn hidden_piece(raw: String, trailing: bool) -> Piece {
    Piece {
        guard: None,
        physical_prefix: false,
        literal_url: None,
        raw,
        origin: None,
        timing: false,
        display: String::new(),
        spans: Vec::new(),
        trailing,
        definition: None,
    }
}

fn starts_at(pieces: &[Piece], at: usize) -> bool {
    pieces
        .iter()
        .any(|piece| matches!(&piece.origin, Some(PieceOrigin::Source(r)) if r.start == at))
}

fn within(piece: &Piece, range: &Range<usize>) -> bool {
    matches!(&piece.origin, Some(PieceOrigin::Source(r)) if range.start <= r.start && r.end <= range.end)
}

/// Gives each fence whose opener or closer the cut dropped (with the other
/// kept) its missing end again, where the surviving lines now begin or end.
/// A fence the replacement owned whole is gone from both lists and is left;
/// one with no closer (open to the end of the note) has only an opener to
/// lose. `ends_note` says the context ends the note, whose final line ending
/// is hidden after a closing fence and shown after anything else.
pub(super) fn rebalance(
    frames: &[Fence],
    raw: &str,
    before: &mut Vec<Piece>,
    after: &mut Vec<Piece>,
    selecting: bool,
    ends_note: bool,
) {
    // Fences that lost their opener first: the lines they leave may be the
    // ones a fence that lost its closer then closes after.
    let mut lost = Vec::new();
    for frame in frames {
        // A closer outside this context is never cut; neither is an opener.
        let closer = frame.closer.clone();
        if closer.as_ref().is_some_and(|closer| closer.end > raw.len()) {
            continue;
        }
        let opener_in_context = raw
            .get(frame.opener.clone())
            .is_some_and(|text| !text.is_empty() && text.bytes().all(|byte| byte == frame.marker));
        // The closer's line: where it starts, and where its text and ending end.
        let line = closer.as_ref().map(|closer| {
            let start = raw[..closer.start].rfind('\n').map_or(0, |at| at + 1);
            let eol = raw[closer.start..]
                .find('\n')
                .map_or(raw.len(), |at| closer.start + at);
            let text_end = eol - usize::from(raw[..eol].ends_with('\r'));
            (start, text_end, raw.len().min(eol + 1))
        });
        // A selection that begins where the body ends takes the closer
        // line's ending with it, so the frame's hidden tail goes too.
        if let (true, Some((_, text_end, _))) = (selecting, line) {
            let tail = frame.body.end..text_end;
            while before.last().is_some_and(|piece| within(piece, &tail)) {
                before.pop();
            }
        }
        let kept = |at: usize| starts_at(before, at) || starts_at(after, at);
        let opener_kept = !opener_in_context || kept(frame.opener.start);
        let closer_kept = closer.as_ref().is_none_or(|closer| kept(closer.start));
        if opener_kept != closer_kept {
            lost.push((frame, line, opener_kept));
        }
    }
    lost.sort_by_key(|&(_, _, opener_kept)| opener_kept);
    for (frame, line, opener_kept) in lost {
        let Some((line_start, text_end, line_end)) = line else {
            reopen(frame, raw, after, None, false);
            continue;
        };
        if opener_kept {
            // The closer went with the selection: it closes the line the
            // surviving text ended up on, before that line's own ending.
            let ending = raw
                .get(frame.separator.clone())
                .filter(|ending| !ending.is_empty())
                .unwrap_or("\n");
            let first_break = after.iter().position(|piece| piece.raw.contains('\n'));
            let mut at = first_break.unwrap_or(after.len());
            if at > 0 && at < after.len() && after[at - 1].raw.ends_with('\r') {
                at -= 1;
            }
            let last = first_break.is_some_and(|end| end + 1 == after.len());
            // What joins the code line is code: opaque text, no inline spans.
            for piece in &mut after[..at] {
                piece.spans.clear();
            }
            after.splice(
                at..at,
                [
                    hidden_piece(ending.to_owned(), true),
                    hidden_piece(raw[line_start..text_end].to_owned(), false),
                ],
            );
            if ends_note && last {
                for piece in &mut after[at + 2..] {
                    piece.display.clear();
                }
            }
        } else {
            let gone = frame.body.end..text_end;
            reopen(
                frame,
                raw,
                after,
                Some((gone, text_end..line_end)),
                ends_note,
            );
        }
    }
}

/// The opener went with the selection. Code lines after the first one that
/// survive open the block again, with the lines' own container prefix; when
/// only the end of one line survives it is text, so the frame goes too: its
/// closer line (`frame_and_ending`, when there is one) is removed and its
/// ending shows, unless it is the note's final one (`ends_note`): hidden
/// after the frame, it goes with it rather than show as a new line.
fn reopen(
    frame: &Fence,
    raw: &str,
    after: &mut Vec<Piece>,
    frame_and_ending: Option<(Range<usize>, Range<usize>)>,
    ends_note: bool,
) {
    let next = after
        .iter()
        .position(|piece| within(piece, &frame.body) && piece.raw.ends_with('\n'));
    let Some(next) = next else {
        let (gone, ending) = frame_and_ending.unwrap_or((0..0, frame.separator.clone()));
        let last = ends_note && ending.end == raw.len();
        after.retain(|piece| !within(piece, &gone) && !(last && within(piece, &ending)));
        for piece in after.iter_mut().filter(|piece| within(piece, &ending)) {
            piece.display = piece.raw.clone();
        }
        return;
    };
    let opener_end = raw[frame.opener.start..]
        .find('\n')
        .map_or(raw.len(), |at| frame.opener.start + at + 1);
    let prefix: String = after[next + 1..]
        .iter()
        .take_while(|piece| indent_or_quote(piece))
        .map(|piece| piece.raw.as_str())
        .collect();
    let opener = format!("{prefix}{}", &raw[frame.opener.start..opener_end]);
    after.insert(next + 1, hidden_piece(opener, false));
}

fn indent_or_quote(piece: &Piece) -> bool {
    piece.display.is_empty()
        && !piece.raw.is_empty()
        && piece.raw.chars().all(|ch| matches!(ch, ' ' | '\t' | '>'))
}

thread_local! {
    static REPAIR: std::cell::Cell<State> = const { std::cell::Cell::new(State::CLOSED) };
    static LAST_REPAIRED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// No input is open: one may open (`Repair::open`).
    Closed,
    /// An input that checks its whole result is open: the planner may repair.
    Open,
    /// Planning as before repairs (`Repair::bar`).
    Barred,
}

#[derive(Clone, Copy)]
struct State {
    mode: Mode,
    /// The planner is planning with a frame end given back.
    held: bool,
    /// A plan with a frame end given back was accepted in this input.
    repaired: bool,
}

impl State {
    const CLOSED: Self = Self {
        mode: Mode::Closed,
        held: false,
        repaired: false,
    };
}

/// When the planner may give a fence back the frame end its cut dropped
/// (`rebalance`): only inside an input that checks its whole result before
/// the host accepts it (`EditorSession::checked_input`), and there only to
/// plan again an input it refused without it, or a paste out of code. Held
/// values restore the state before them when dropped.
pub(crate) struct Repair(State);

impl Repair {
    fn set(change: impl FnOnce(&mut State)) -> Self {
        Self(REPAIR.with(|slot| {
            let old = slot.get();
            let mut new = old;
            change(&mut new);
            slot.set(new);
            old
        }))
    }

    /// Whether no input is open, so one may open.
    pub(crate) fn closed() -> bool {
        REPAIR.with(|slot| slot.get().mode == Mode::Closed)
    }

    /// Opens an input whose result the caller checks.
    pub(crate) fn open() -> Self {
        Self::set(|state| {
            *state = State {
                mode: Mode::Open,
                ..State::CLOSED
            }
        })
    }

    /// Plans as before repairs, the inputs inside too, until dropped.
    pub(crate) fn bar() -> Self {
        Self::set(|state| state.mode = Mode::Barred)
    }

    /// Has the open input's result checked, as a repaired one's is.
    pub(crate) fn mark() {
        REPAIR.with(|slot| {
            slot.set(State {
                repaired: true,
                ..slot.get()
            })
        });
    }

    pub(crate) fn may() -> bool {
        REPAIR.with(|slot| slot.get().mode == Mode::Open)
    }

    /// Plans with a frame end given back.
    pub(crate) fn hold() -> Self {
        Self::set(|state| state.held = true)
    }

    pub(super) fn held() -> bool {
        REPAIR.with(|slot| slot.get().held)
    }

    /// Whether a repaired plan was accepted in the open input.
    pub(crate) fn repaired() -> bool {
        REPAIR.with(|slot| slot.get().repaired)
    }

    /// `plan`, held: accepted, it is noted for `repaired`.
    pub(super) fn retry<T>(plan: impl Fn() -> Result<T, EditorError>) -> Result<T, EditorError> {
        let planned = {
            let _held = Self::hold();
            plan()?
        };
        Self::mark();
        Ok(planned)
    }
}

impl Drop for Repair {
    fn drop(&mut self) {
        REPAIR.with(|slot| {
            let repaired = slot.get().repaired;
            if self.0.mode == Mode::Closed {
                LAST_REPAIRED.with(|last| last.set(repaired));
            }
            // Inside one input a repair stays noted; leaving it, it goes.
            let repaired = if self.0.mode == Mode::Open {
                repaired
            } else {
                self.0.repaired
            };
            slot.set(State { repaired, ..self.0 });
        });
    }
}

/// Whether the last input to close had a repaired plan accepted.
#[cfg(test)]
pub(crate) fn last_repaired() -> bool {
    LAST_REPAIRED.with(std::cell::Cell::get)
}

/// Whether the planner may `Repair::retry` an input over `range`: a
/// selection, inside an open input and outside a retry, with neither end
/// between a CR and its LF (Undo could not select that range again as given).
pub(super) fn may_repair(display: &ropey::Rope, range: crate::DisplayRange) -> bool {
    range.start != range.end
        && Repair::may()
        && !Repair::held()
        && ![range.start.0, range.end.0].into_iter().any(|at| {
            at > 0
                && at < display.len_bytes()
                && display.byte(at - 1) == b'\r'
                && display.byte(at) == b'\n'
        })
}

//! Repairs for a replacement whose selection crosses a block boundary. Text
//! after the selection joins the line the selection began on, as it does
//! across any block boundary, and the lines left keep their own block. For a
//! code block that takes one end of its frame, the lines left stay code; for
//! list items the selection's text joined above, the items are respelled so
//! they still read as a list there.
use super::{Piece, PieceOrigin};
use crate::inline::fences::Fence;
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
            reopen(frame, raw, after, None);
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
            reopen(frame, raw, after, Some((gone, text_end..line_end)));
        }
    }
}

/// The opener went with the selection. Code lines after the first one that
/// survive open the block again, with the lines' own container prefix; when
/// only the end of one line survives it is text, so the frame goes too: its
/// closer line (`frame_and_ending`, when there is one) is removed and its
/// ending, hidden as the note's final one, shows.
fn reopen(
    frame: &Fence,
    raw: &str,
    after: &mut Vec<Piece>,
    frame_and_ending: Option<(Range<usize>, Range<usize>)>,
) {
    let next = after
        .iter()
        .position(|piece| within(piece, &frame.body) && piece.raw.ends_with('\n'));
    let Some(next) = next else {
        let (gone, ending) = frame_and_ending.unwrap_or((0..0, frame.separator.clone()));
        after.retain(|piece| !within(piece, &gone));
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
    static RESTART_LISTS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// While held, the lines after the text a replacement joins are respelled to
/// read as list items there: an item indented four columns or more (its
/// parent went with the selection) loses that indent, and an ordered one
/// starts at 1. CommonMark reads either as a continuation of the joined
/// text otherwise, so the item would turn into visible marker characters.
pub(crate) struct RestartLists(bool);

impl RestartLists {
    pub(crate) fn set() -> Self {
        Self(RESTART_LISTS.with(|slot| slot.replace(true)))
    }

    /// Whether a `RestartLists` is held: the planner's context then also
    /// holds the row after the replaced range, whose lines may need the same.
    pub(super) fn held() -> bool {
        RESTART_LISTS.with(|slot| slot.get())
    }
}

impl Drop for RestartLists {
    fn drop(&mut self) {
        RESTART_LISTS.with(|slot| slot.set(self.0));
    }
}

fn hidden(piece: &Piece) -> bool {
    piece.display.is_empty() && !piece.raw.is_empty()
}

fn indent(piece: &Piece) -> bool {
    hidden(piece) && piece.raw.chars().all(|ch| matches!(ch, ' ' | '\t'))
}

/// Respells the lines after the first one of `after`; see `RestartLists`.
pub(super) fn restart_lists(after: &mut Vec<Piece>) {
    if !RestartLists::held() {
        return;
    }
    // The first shown line break ends the joined line; a closer's hidden
    // frame ending does not.
    let Some(line_end) = after
        .iter()
        .position(|piece| piece.raw.contains('\n') && !piece.display.is_empty())
    else {
        return;
    };
    let mut line = line_end + 1;
    let mut removed = None;
    // The run of lines up to the next blank one keeps its relative indents.
    while line < after.len() && !after[line].raw.starts_with('\n') {
        let end = line
            + after[line..]
                .iter()
                .take_while(|piece| indent(piece))
                .count();
        let mut columns = 0usize;
        for ch in after[line..end].iter().flat_map(|piece| piece.raw.chars()) {
            columns += if ch == '\t' { 4 - columns % 4 } else { 1 };
        }
        let removed = *removed.get_or_insert(if columns >= 4 { columns } else { 0 });
        let mut from = end;
        if removed > 0 {
            let spaces = " ".repeat(columns.saturating_sub(removed));
            from = line + usize::from(!spaces.is_empty());
            after.splice(
                line..end,
                (!spaces.is_empty()).then(|| hidden_piece(spaces, false)),
            );
        }
        match after[from..]
            .iter()
            .position(|piece| piece.raw.contains('\n'))
        {
            Some(next) => line = from + next + 1,
            None => break,
        }
    }
    let mut at = line_end + 1;
    while after.get(at).is_some_and(|piece| {
        hidden(piece) && piece.raw.chars().all(|ch| matches!(ch, ' ' | '\t' | '>'))
    }) {
        at += 1;
    }
    let digits = after[at..]
        .iter()
        .take_while(|piece| hidden(piece) && piece.raw.bytes().all(|byte| byte.is_ascii_digit()))
        .count();
    let delimiter = after
        .get(at + digits)
        .is_some_and(|piece| hidden(piece) && matches!(piece.raw.as_str(), "." | ")"));
    if digits == 0 || !delimiter || (digits == 1 && after[at].raw == "1") {
        return;
    }
    after[at].raw = "1".into();
    after[at].origin = None;
    after.drain(at + 1..at + digits);
}

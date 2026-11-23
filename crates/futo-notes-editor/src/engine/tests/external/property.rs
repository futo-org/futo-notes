//! The property: random local edits, a random outside change to lines and
//! line breaks they never touched (next to them included), adoption of both;
//! then nothing but front matter refuses, both contributions are there, undo
//! and redo restore exact bytes at the selections they promise, and the
//! reading equals a fresh read.
use super::super::super::Engine;
use super::super::properties::{
    apply_view, cases, check_fresh, note, step, BlockMirror, Model, Random, View,
};
use super::{ok, redo, undo};
use crate::{Affinity, EditorError};
use similar::{capture_diff_slices, Algorithm, DiffOp};

/// The outside contribution: lines `[start, end)` of the original replaced
/// with lines carrying a character no generated note holds, so neither a
/// diff nor a merge can place them anywhere else.
struct Outside {
    start: usize,
    end: usize,
    text: String,
}

impl Outside {
    /// `text` (a local state) with the outside change applied; `shift` moves
    /// it past the local edits when it lies after them.
    fn applied(&self, text: &str, shift: isize) -> String {
        let start = self.start.saturating_add_signed(shift);
        let end = self.end.saturating_add_signed(shift);
        format!("{}{}{}", &text[..start], self.text, &text[end..])
    }
}

/// Line starts of `text`, with its end when it ends a line.
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(text.match_indices('\n').map(|(at, _)| at + 1));
    starts
}

/// The outside change: whole lines, or new lines at a line break, apart
/// from every line and line break any local state changed (`touched`, as
/// slots: line `i` is slot `2i + 1`, the line break before it slot `2i`).
fn outside(
    original: &str,
    touched: Option<(usize, usize)>,
    random: &mut Random,
) -> Option<Outside> {
    let starts = line_starts(original);
    let apart = |lo: usize, hi: usize| touched.is_none_or(|(first, last)| hi < first || lo > last);
    let candidates: Vec<usize> = (0..starts.len())
        .filter(|&line| apart(2 * line, 2 * line + 1))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let first = candidates[random.below(candidates.len())];
    let mut last = first;
    for _ in 0..random.below(3) {
        if last + 1 < starts.len() && apart(2 * last + 2, 2 * last + 3) {
            last += 1;
        }
    }
    let start = starts[first];
    // Lines first..last are replaced, or (half the time) nothing is.
    let end = if random.below(2) == 0 {
        start
    } else {
        starts.get(last + 1).copied().unwrap_or(original.len())
    };
    let mut text = String::new();
    for _ in 0..1 + random.below(2) {
        text.push_str(random.pick(&["", "# ", "- ", "> ", "```", "| a | ", "**", "1. "]));
        text.push('Ω');
        text.push_str(random.pick(&["", "word", " *b* ", "`c`", "[[n]]"]));
        text.push_str("Ω\n");
    }
    Some(Outside { start, end, text })
}

/// What a state looked like: its text, its selection and the source offsets
/// each end of the selection may stand at.
struct Seen {
    source: String,
    selection: crate::DisplayRange,
    affinity: Affinity,
    ends: [(usize, usize); 2],
}

fn seen(engine: &Engine) -> Seen {
    let selection = engine.selection();
    Seen {
        source: engine.source_text(),
        selection,
        affinity: engine.affinity(),
        ends: [
            engine.source_span(selection.start.0),
            engine.source_span(selection.end.0),
        ],
    }
}

/// `engine` shows `want` with the outside change in: the exact text, and a
/// selection at the same text.
fn check_seen(
    engine: &Engine,
    want: &Seen,
    outside: &Outside,
    after: bool,
    original: usize,
    context: &str,
) {
    let shift = if after {
        want.source.len() as isize - original as isize
    } else {
        0
    };
    assert_eq!(
        engine.source_text(),
        outside.applied(&want.source, shift),
        "text {context}"
    );
    assert_eq!(engine.affinity(), want.affinity, "affinity {context}");
    let (start, end) = (
        outside.start.saturating_add_signed(shift),
        outside.end.saturating_add_signed(shift),
    );
    let grown = outside.text.len() as isize - (outside.end - outside.start) as isize;
    // A diff may place the outside change anywhere the bytes around it
    // repeat it; an end in that zone may stand on either copy.
    let now = engine.source_text();
    let shared = |a: &mut dyn Iterator<Item = (u8, u8)>| a.take_while(|(x, y)| x == y).count();
    let first = shared(&mut want.source.bytes().zip(now.bytes()));
    let last = want.source.len()
        - shared(&mut want.source.bytes().rev().zip(now.bytes().rev())).min(want.source.len());
    let (start, end) = (start.min(last), end.max(first));
    let selection = engine.selection();
    for (have, (lo, hi)) in [selection.start.0, selection.end.0]
        .into_iter()
        .zip(want.ends)
    {
        if hi >= start && lo <= end {
            continue;
        }
        let moved = |at: usize| {
            if at > end {
                at.saturating_add_signed(grown)
            } else {
                at
            }
        };
        let (lo, hi) = (engine.display_of(moved(lo)), engine.display_of(moved(hi)));
        assert!(
            lo <= have && have <= hi,
            "selection {selection:?} shows {have}, not {lo}..={hi}, for {:?} {:?} in {:?}, now {:?} pin {:?} outside {start}..{end} {context}",
            want.selection, want.ends, want.source, engine.source_text(), engine.pin
        );
    }
    check_fresh(engine, context);
}

/// A note after random local edits, with every state its history holds.
struct Local {
    original: String,
    engine: Engine,
    /// Every text the note passed through.
    visited: Vec<String>,
    context: String,
    now: Seen,
    /// The states undo reaches from `now`, then those redo reaches after.
    undone: Vec<Seen>,
    redone: Vec<Seen>,
}

fn local_edits(case: usize, random: &mut Random) -> Local {
    let original = format!("{}\n{}", note(random), note(random));
    let mut engine = Engine::open(&original);
    let mut model = Model::default();
    let mut view = View::new(engine.display_text());
    let mut visited = vec![original.clone()];
    let mut steps = Vec::new();
    for _ in 0..random.below(14) {
        steps.push(step(&mut engine, &mut model, &mut view, random));
        visited.push(engine.source_text());
    }
    let context = format!("case {case} from {original:?} after {steps:?}");
    let now = seen(&engine);
    let mut undone = Vec::new();
    while undo(&mut engine) {
        undone.push(seen(&engine));
    }
    let mut redone = Vec::new();
    while redo(&mut engine) {
        redone.push(seen(&engine));
    }
    for _ in undone.len()..redone.len() {
        assert!(undo(&mut engine));
    }
    assert_eq!(engine.source_text(), now.source, "{context}");
    engine
        .select_with_affinity(engine.revision(), now.selection, now.affinity)
        .unwrap();
    Local {
        original,
        engine,
        visited,
        context,
        now,
        undone,
        redone,
    }
}

/// The slots of `original` (see `outside`) any of `visited` changed, read
/// both from the bytes it shares at its start and end and from a line diff,
/// so a line either reading could place an edit on counts as touched.
fn touched(original: &str, visited: &[String]) -> Option<(usize, usize)> {
    let starts = line_starts(original);
    let line_of = |at: usize| starts.partition_point(|&start| start <= at) - 1;
    let lines = |text: &str| {
        text.split_inclusive('\n')
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let old_lines = lines(original);
    visited
        .iter()
        .filter(|text| **text != original)
        .flat_map(|text| {
            let prefix = original
                .bytes()
                .zip(text.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let suffix = original
                .bytes()
                .rev()
                .zip(text.bytes().rev())
                .take_while(|(a, b)| a == b)
                .count();
            // Shared bytes read first from the start, then first from the
            // end: an edit among repeated bytes may stand anywhere between.
            let shorter = original.len().min(text.len());
            let lo = prefix.min(shorter - suffix);
            let hi = original.len() - suffix.min(shorter - prefix);
            let lo_slot = 2 * line_of(lo) + usize::from(!starts.contains(&lo));
            let by_bytes = (lo_slot, 2 * line_of(hi) + 1);
            let by_lines = capture_diff_slices(Algorithm::Myers, &old_lines, &lines(text))
                .into_iter()
                .filter(|change| !matches!(change, DiffOp::Equal { .. }))
                .map(|change| {
                    // Lines that only change keep the line breaks around them;
                    // lines written or removed stand on them.
                    let (before, after) = (change.old_range(), change.new_range());
                    match before.len() == after.len() {
                        true => (2 * before.start + 1, 2 * before.end - 1),
                        false => (2 * before.start, 2 * before.end),
                    }
                });
            std::iter::once(by_bytes)
                .chain(by_lines)
                .collect::<Vec<_>>()
        })
        .reduce(|(a, b), (c, d)| (a.min(c), b.max(d)))
}

/// A change on lines no local edit touched is refused only for front
/// matter, or right next to the edits where repeated bytes let one edit be
/// read at either place; the refusal changes nothing, and dropping history
/// still adopts. Whether front matter explains it.
fn check_refusal(
    local: &mut Local,
    next_to: bool,
    remote: &str,
    merged: &str,
    context: &str,
) -> bool {
    let engine = &mut local.engine;
    let text = local.now.source.clone();
    let front_matter = [local.original.as_str(), remote, &text, merged]
        .iter()
        .any(|text| text.starts_with("---"));
    assert!(
        front_matter || next_to,
        "refused apart from the edits: {context}"
    );
    assert_eq!(engine.source_text(), text, "{context}");
    assert_eq!(engine.selection(), local.now.selection, "{context}");
    let plan = engine
        .prepare_external(engine.revision(), merged, false)
        .unwrap();
    engine.adopt(plan, &mut ok).unwrap();
    assert_eq!(engine.source_text(), merged, "{context}");
    assert!(!engine.can_undo() && !engine.can_redo(), "{context}");
    check_fresh(engine, context);
    front_matter
}

#[test]
fn random_outside_changes_keep_every_contribution_and_exact_undo() {
    let mut random = Random::from_env();
    let (mut adopted, mut refused, mut refused_next_to, mut skipped) = (0, 0, 0, 0);
    for case in 0..cases() {
        let mut local = local_edits(case, &mut random);
        let original = local.original.clone();
        let text = local.now.source.clone();
        let touched = touched(&original, &local.visited);
        let Some(outside) = outside(&original, touched, &mut random) else {
            skipped += 1;
            continue;
        };
        let starts = line_starts(&original);
        let line_of = |at: usize| starts.partition_point(|&start| start <= at) - 1;
        let (lo, hi) = match outside.start == outside.end {
            true => (2 * line_of(outside.start), 2 * line_of(outside.start)),
            false => (
                2 * line_of(outside.start) + 1,
                2 * line_of(outside.end - 1) + 1,
            ),
        };
        let after = touched.is_some_and(|(_, last)| lo > last);
        let next_to = touched.is_some_and(|(first, last)| lo == last + 1 || hi + 1 == first);
        let remote = outside.applied(&original, 0);
        let shift = if after {
            text.len() as isize - original.len() as isize
        } else {
            0
        };
        let merged = outside.applied(&text, shift);
        let context = format!("{} with {remote:?}", local.context);
        let engine = &mut local.engine;
        let plan = match engine.prepare_external(engine.revision(), &merged, true) {
            Ok(plan) => plan,
            Err(error) => {
                assert_eq!(error, EditorError::UnrepresentableFormat, "{context}");
                if !check_refusal(&mut local, next_to, &remote, &merged, &context) {
                    refused_next_to += 1;
                }
                refused += 1;

                continue;
            }
        };
        let mut view = View::new(engine.display_text());
        let mut mirror = BlockMirror::open(engine);
        if let Some(change) = engine.adopt(plan, &mut ok).unwrap() {
            apply_view(&mut view, &change);
        }
        assert_eq!(view.text, engine.display_text(), "view {context}");
        mirror.check(engine, &mut view, &context);
        let check = |engine: &Engine, want: &Seen, what: String| {
            check_seen(engine, want, &outside, after, original.len(), &what);
        };
        // (c) The reading equals a fresh read; the selection is at the same text.
        check(engine, &local.now, format!("adopted {context}"));
        // (a) Undoing everything reaches the outside version without the
        // local edits, byte for byte, each step at the selection it promises.
        for (index, want) in local.undone.iter().enumerate() {
            assert!(undo(engine), "undo {index} {context}");
            check(engine, want, format!("undo {index} {context}"));
        }
        assert!(!undo(engine), "{context}");
        assert_eq!(engine.source_text(), remote, "undone {context}");
        // (b) Redo replays to the merged source, then on through the redo
        // steps that were waiting.
        for (index, want) in local.redone.iter().enumerate() {
            assert!(redo(engine), "redo {index} {context}");
            check(engine, want, format!("redo {index} {context}"));
            if index + 1 == local.undone.len() {
                assert_eq!(engine.source_text(), merged, "redone {context}");
            }
        }
        assert!(!redo(engine), "{context}");
        adopted += 1;
    }
    let counts = format!(
        "adopted {adopted}, refused {refused} ({refused_next_to} next to the edits), skipped {skipped}"
    );
    eprintln!("{counts}");
    // The generator's own guard: most cases adopt. Refusals are mostly the front-matter
    // history policy, and how many notes get front matter depends on the seed: over 100
    // seeds they ran 11 of 300 on average and 20 at most, before and after list markers
    // took a place in the display.
    assert!(
        adopted > cases() / 2 && refused < cases() / 10 && refused_next_to <= adopted / 100,
        "{counts}"
    );
}

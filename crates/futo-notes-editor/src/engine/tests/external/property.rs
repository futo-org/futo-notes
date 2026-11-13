//! The property: random local edits, a random outside change to lines they
//! never touched, a three-way merge, adoption; then both contributions are
//! there, undo and redo restore exact bytes at the selections they promise,
//! and the reading equals a fresh read.
use super::super::super::Engine;
use super::super::properties::{apply_view, cases, check_fresh, note, step, Model, Random, View};
use super::{ok, redo, undo};
use crate::{Affinity, EditorError};
use futo_notes_merge::{three_way_merge, MergeResult};

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

/// The outside change: whole lines at least two lines away from the bytes
/// any local state changed (`touched`, in the original's offsets).
fn outside(
    original: &str,
    touched: Option<(usize, usize)>,
    random: &mut Random,
) -> Option<Outside> {
    let starts = line_starts(original);
    let line_of = |at: usize| starts.partition_point(|&start| start <= at) - 1;
    let allowed = |line: usize| match touched {
        None => true,
        Some((lo, hi)) => line + 2 < line_of(lo) || line > line_of(hi) + 2,
    };
    let candidates: Vec<usize> = (0..starts.len()).filter(|&line| allowed(line)).collect();
    if candidates.is_empty() {
        return None;
    }
    let first = candidates[random.below(candidates.len())];
    let mut last = first;
    for _ in 0..random.below(3) {
        if last + 1 < starts.len() && allowed(last + 1) {
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

/// The bytes of `original` any of `visited` changed.
fn touched(original: &str, visited: &[String]) -> Option<(usize, usize)> {
    visited
        .iter()
        .filter(|text| **text != original)
        .map(|text| {
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
                .count()
                .min(original.len() - prefix);
            (prefix, original.len() - suffix)
        })
        .reduce(|(a, b), (c, d)| (a.min(c), b.max(d)))
}

/// A refusal is explained by front matter or by an ambiguous merge of a
/// historical text, and changes nothing; dropping history still adopts.
fn check_refusal(local: &mut Local, remote: &str, merged: &str, context: &str) {
    let engine = &mut local.engine;
    let text = local.now.source.clone();
    let ambiguous = local
        .undone
        .iter()
        .chain(&local.redone)
        .any(|state| three_way_merge(&text, merged, &state.source) == MergeResult::Conflict);
    let front_matter = [local.original.as_str(), remote, &text, merged]
        .iter()
        .any(|text| text.starts_with("---"));
    assert!(
        ambiguous || front_matter,
        "refused with no ambiguity: {context}"
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
}

#[test]
fn random_outside_changes_keep_every_contribution_and_exact_undo() {
    let mut random = Random::from_env();
    let (mut adopted, mut refused, mut skipped) = (0, 0, 0);
    for case in 0..cases() {
        let mut local = local_edits(case, &mut random);
        let original = local.original.clone();
        let text = local.now.source.clone();
        let touched = touched(&original, &local.visited);
        let Some(outside) = outside(&original, touched, &mut random) else {
            skipped += 1;
            continue;
        };
        let after = touched.is_some_and(|(_, hi)| outside.start > hi);
        let remote = outside.applied(&original, 0);
        // Repeated lines can make even a merge of disjoint lines ambiguous;
        // the store parks those before any adoption.
        let MergeResult::Clean(merged) = three_way_merge(&original, &remote, &text) else {
            skipped += 1;
            continue;
        };
        let shift = if after {
            text.len() as isize - original.len() as isize
        } else {
            0
        };
        let context = format!("{} with {remote:?}", local.context);
        // (a) The merge holds both contributions.
        assert_eq!(merged, outside.applied(&text, shift), "merged {context}");
        let engine = &mut local.engine;
        let plan = match engine.prepare_external(engine.revision(), &merged, true) {
            Ok(plan) => plan,
            Err(error) => {
                assert_eq!(error, EditorError::UnrepresentableFormat, "{context}");
                check_refusal(&mut local, &remote, &merged, &context);
                refused += 1;
                continue;
            }
        };
        let mut view = View::new(engine.display_text());
        if let Some(change) = engine.adopt(plan, &mut ok).unwrap() {
            apply_view(&mut view, &change);
        }
        assert_eq!(view.text, engine.display_text(), "view {context}");
        let check = |engine: &Engine, want: &Seen, what: String| {
            check_seen(engine, want, &outside, after, original.len(), &what);
        };
        // (d) The reading equals a fresh read; the selection is at the same text.
        check(engine, &local.now, format!("adopted {context}"));
        // (b) Undoing everything reaches the outside version without the
        // local edits, byte for byte, each step at the selection it promises.
        for (index, want) in local.undone.iter().enumerate() {
            assert!(undo(engine), "undo {index} {context}");
            check(engine, want, format!("undo {index} {context}"));
        }
        assert!(!undo(engine), "{context}");
        assert_eq!(engine.source_text(), remote, "undone {context}");
        // (c) Redo replays to the merged source, then on through the redo
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
    eprintln!("adopted {adopted}, refused {refused}, skipped {skipped}");
    assert!(
        adopted > cases() / 2 && refused < cases() / 20,
        "adopted {adopted}, refused {refused}, skipped {skipped}"
    );
}

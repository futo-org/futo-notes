//! Cut, then paste what it copied at the caret it left: the note's bytes come
//! back. Over random notes of plain, indented and inline-code lines, or of
//! quoted ones (a paste whose last line is a block puts the text after the
//! caret on a line of its own, clipboard.md "Paste"), at random selections that take a stretch of the source out as it stands
//! (a cut that only removes bytes, and copies them without added marks) and
//! do not end with a line ending, which a paste drops (clipboard.md "Paste").
use super::*;

const PLAIN: &[&str] = &[
    "ab cd ef",
    "  ab cd",
    "\tab cd",
    "ab  cd",
    "`gamma` delta",
    "x `co de` y",
    "plain",
];

const QUOTED: &[&str] = &["> ab cd", ">  ab cd", "> `gamma` x", "> plain"];

/// The note's source after cutting display `range`, and what the cut copied.
fn cut(engine: &mut Engine, range: DisplayRange) -> Option<String> {
    let (copied, _) = engine
        .cut_markdown(engine.revision(), range, &mut ok)
        .ok()?;
    Some(copied)
}

/// Whether `after` is `before` less one stretch of its source, and that
/// stretch is `copied`.
fn took_exactly(before: &str, after: &str, copied: &str) -> bool {
    before.len() == after.len() + copied.len()
        && (0..=after.len()).any(|at| {
            after.is_char_boundary(at)
                && before.starts_with(&after[..at])
                && before.ends_with(&after[at..])
                && before[at..].starts_with(copied)
        })
}

#[test]
fn cutting_then_pasting_in_place_restores_the_bytes() {
    let mut random = Random::from_env();
    let mut checked = 0;
    for case in 0..cases() {
        let parts = if random.below(2) == 0 { PLAIN } else { QUOTED };
        let lines: Vec<&str> = (0..1 + random.below(3))
            .map(|_| random.pick(parts))
            .collect();
        let source = lines.join("\n");
        let mut engine = Engine::open(&source);
        let shown = engine.display_text();
        let (a, b) = (random.below(shown.len() + 1), random.below(shown.len() + 1));
        let (a, b) = (a.min(b), a.max(b));
        if a == b || !shown.is_char_boundary(a) || !shown.is_char_boundary(b) {
            continue;
        }
        let range = DisplayRange {
            start: DisplayOffset(a),
            end: DisplayOffset(b),
        };
        let Some(copied) = cut(&mut engine, range) else {
            continue;
        };
        if copied.ends_with('\n') || !took_exactly(&source, &engine.source_text(), &copied) {
            continue;
        }
        checked += 1;
        let caret = engine.selection();
        engine
            .paste_markdown(engine.revision(), caret, &copied, &mut ok)
            .unwrap();
        assert_eq!(
            engine.source_text(),
            source,
            "case {case}: cut {a}..{b} of {source:?} (copied {copied:?}) and pasted it back"
        );
    }
    assert!(checked > cases() / 10, "only {checked} cases cut cleanly");
}

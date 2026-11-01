//! Cross-feature input never panics and always leaves a projection equal to a fresh
//! open: non-ASCII neighbors, link and table syntax typed into cut fences, lists and
//! table cells, paste, IME commit and header tags (#283).
use crate::{
    DisplayOffset, DisplayRange, EditorSession, ParagraphKey, ProjectionSlice, SourceEdit,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn whole(session: &EditorSession) -> ProjectionSlice {
    let end = session.display_text().len();
    let mut slice = session.project(session.revision(), range(0, end)).unwrap();
    slice.revision = crate::Revision(0);
    slice.correspondence.clear();
    slice.links.clear();
    slice
}

const PIECES: &[&str] = &[
    "---\ntags: [tag1]\n---\n",
    "Done 🎉\n\n",
    "今天好文\n\n",
    "[ab](u) x\n",
    "- ünï **bö** `cö` 😀\n",
    "| é | 😀 |\n|---|---|\n| ß | Σ |\n",
    "a [[Wiki|label]] b\n",
    "> ﬁ **ẞ** [[Ünï]]\n",
    "plain *em* 中文\n",
    "\n",
    "#tag1 #tâg\n\n",
];
const TEXTS: &[&str] = &[
    "[[", "](", "]", "|", "x", "é", "😀", "中", "\n", "**", "\\", "a|b", "- ", "```",
];

fn source(next: &mut impl FnMut(usize) -> usize) -> String {
    let mut source = String::new();
    for _ in 0..1 + next(6) {
        if next(4) != 0 {
            source.push_str(PIECES[next(PIECES.len())]);
            continue;
        }
        // A region long enough to be cut into rows.
        let lines = 200 + next(150);
        match next(3) {
            0 => {
                source.push_str("```\n");
                (0..lines).for_each(|i| source.push_str(&format!("code {i}\n")));
                source.push_str("```\n- item 1\n");
            }
            1 => (0..lines).for_each(|i| source.push_str(&format!("- item {i} é\n"))),
            _ => {
                source.push_str("| a | b |\n|---|---|\n");
                (0..lines).for_each(|i| source.push_str(&format!("| {i} | 中{i} |\n")));
            }
        }
        source.push('\n');
    }
    source
}

/// A caret anywhere, at a line start, or just inside a link label or cell.
fn caret(display: &str, next: &mut impl FnMut(usize) -> usize) -> usize {
    let mut at = next(display.len() + 1);
    while !display.is_char_boundary(at) {
        at -= 1;
    }
    match next(3) {
        0 => display[..at].rfind('\n').map_or(0, |line| line + 1),
        1 => display[at..]
            .find(|c| matches!(c, ' ' | '|'))
            .map_or(at, |gap| at + gap),
        _ => at,
    }
}

#[test]
fn cross_feature_edits_match_a_fresh_open() {
    let mut seed = 0x51ed_270b_9f3a_c845u64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("SPLIT_CASES").map_or(60, |cases| cases.parse().unwrap());
    for case in 0..cases {
        let original = source(&mut next);
        let mut session = EditorSession::open(&original);
        let mut log = Vec::<SourceEdit>::new();
        for step in 0..10 {
            let display = session.display_text();
            let at = caret(&display, &mut next);
            let text = TEXTS[next(TEXTS.len())];
            let revision = session.revision();
            let mut accept = |edit: &SourceEdit| {
                log.push(edit.clone());
                Ok(())
            };
            let caret = range(at, at);
            let op = next(6);
            let edit = std::panic::AssertUnwindSafe(|| match op {
                0 | 1 => drop(session.replace(revision, caret, text, &mut accept)),
                2 => drop(session.paste_markdown(revision, caret, text, &mut accept)),
                3 => {
                    if session.compose(revision, caret, "|x").is_ok() {
                        let revision = session.revision();
                        let committed = format!("{text}z");
                        drop(session.commit_composition(revision, Some(&committed), &mut accept));
                    }
                }
                4 => {
                    let key = [ParagraphKey::Enter, ParagraphKey::Backspace][next(2)];
                    drop(session.paragraph_key(revision, caret, key, &mut accept));
                }
                _ => drop(match next(2) {
                    0 => session.add_header_tag(revision, "newtag", &mut accept),
                    _ => session.remove_header_tag(revision, "tag1", &mut accept),
                }),
            });
            if std::panic::catch_unwind(edit).is_err() {
                panic!("case {case} step {step}: op {op} {text:?} at {at} panicked\n{original:?}");
            }
            let fresh = EditorSession::open(&session.source_text());
            assert!(
                whole(&session) == whole(&fresh),
                "case {case} step {step}: op {op} {text:?} at {at}\n{original:?}"
            );
        }
        let mut replayed = EditorSession::open(&original);
        for edit in &log {
            replayed.replay(edit).unwrap();
        }
        assert_eq!(replayed.source_text(), session.source_text(), "case {case}");
    }
}

/// Widening a refused input to its blank-separated piece reads each row's
/// tail on a character boundary.
#[test]
fn widening_past_a_non_ascii_row_end_does_not_panic() {
    for (source, at, text) in [
        ("Done 🎉\n\n[ab](u) x\n", 11, "]("),
        ("Done 🎉\n\n[ab](u) x\n", 11, "[["),
        ("[a](b) 中文\n\nw\n", 1, "]("),
    ] {
        let mut session = EditorSession::open(source);
        let revision = session.revision();
        let _ = session.replace(revision, range(at, at), text, &mut |_| Ok(()));
        let fresh = EditorSession::open(&session.source_text());
        assert!(whole(&session) == whole(&fresh), "{source:?}");
    }
}

/// A cut fence row that gains `[[` still ends its fence where a fresh open does.
#[test]
fn wikilink_opener_typed_into_a_cut_fence_keeps_the_fence() {
    let body: String = (0..300).map(|i| format!("code {i}\n")).collect();
    for (line, (open, close)) in [0, 120, 240, 299]
        .into_iter()
        .flat_map(|line| [(line, ("```", "```")), (line, ("<pre>", "</pre>"))])
    {
        let source = format!("{open}\n{body}{close}\n- item 1\n");
        let mut session = EditorSession::open(&source);
        let at = session
            .display_text()
            .find(&format!("code {line}\n"))
            .unwrap();
        let revision = session.revision();
        session
            .replace(revision, range(at, at), "[[", &mut |_| Ok(()))
            .unwrap();
        let fresh = EditorSession::open(&session.source_text());
        assert!(whole(&session) == whole(&fresh), "{open} line {line}");
    }
}

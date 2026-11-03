//! A table cut at row lines must behave exactly like a twin session whose rows
//! are never cut, including keys that create, remove or reflank an emphasis
//! run while literal `_` and `*` runs sit in distant rows.
use super::row::UNCUT;
use crate::{DisplayOffset, DisplayRange, EditorSession, ParagraphKey, ProjectionSlice, Revision};

fn uncut<T>(run: impl FnOnce() -> T) -> T {
    UNCUT.with(|uncut| uncut.set(true));
    let result = run();
    UNCUT.with(|uncut| uncut.set(false));
    result
}

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

fn whole(session: &EditorSession) -> (String, ProjectionSlice) {
    let end = session.projection.display.len_bytes();
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(end),
    };
    (
        session.source_text(),
        session.projection.query(Revision(0), range),
    )
}

/// URL cells with emphasis literals: leading and trailing `_` handles and
/// stray `*` in names, some of which pair across many rows.
fn table(rows: usize) -> String {
    let mut source = String::from("| Name | Site | Twitter |\n| --- | --- | --- |\n");
    for i in 0..rows {
        let handle = match i % 23 {
            3 => format!("_duck{i}"),
            11 => format!("duck{i}_"),
            _ => format!("duck{i}"),
        };
        let name = match i % 31 {
            5 => format!("duck *eggs {i}"),
            19 => format!("duck eggs* {i}"),
            _ => format!("duck eggs {i}"),
        };
        source += &format!(
            "| {name} | https://duck{i}.example.com/notes/{i} | https://twitter.com/{handle} |\n"
        );
    }
    source
}

const TEXTS: &[&str] = &["x", "_", "*", "**", "~~", "\\", "_x", "x_", " ", "|", "\n"];
const KEYS: &[ParagraphKey] = &[
    ParagraphKey::Enter,
    ParagraphKey::Backspace,
    ParagraphKey::Delete,
];

#[test]
fn cut_tables_match_uncut_twin_through_delimiter_edits() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound as u64) as usize
    };
    let source = table(300);
    for case in 0..24 {
        let mut cut = EditorSession::open(&source);
        let mut reference = uncut(|| EditorSession::open(&source));
        assert!(cut.projection.rows.len() > 4, "the table is cut");
        assert!(whole(&cut) == whole(&reference), "open");
        for step in 0..10 {
            let display = cut.display_text();
            let mut at = next(display.len());
            // Half the steps land beside a delimiter.
            if next(2) == 0 {
                if let Some(found) = display[at..].find(['_', '*']) {
                    at += found + next(2);
                }
            }
            let revision = cut.revision();
            let what = if next(3) == 0 {
                let key = KEYS[next(KEYS.len())];
                let _ = cut.paragraph_key(revision, caret(at), key, &mut |_| Ok(()));
                uncut(|| {
                    let _ = reference.paragraph_key(revision, caret(at), key, &mut |_| Ok(()));
                });
                format!("key {key:?} at {at}")
            } else {
                let text = TEXTS[next(TEXTS.len())];
                let _ = cut.replace(revision, caret(at), text, &mut |_| Ok(()));
                uncut(|| {
                    let _ = reference.replace(revision, caret(at), text, &mut |_| Ok(()));
                });
                format!("type {text:?} at {at}")
            };
            let (got, want) = (whole(&cut), whole(&reference));
            assert!(got == want, "case {case} step {step}: {what}");
        }
    }
}

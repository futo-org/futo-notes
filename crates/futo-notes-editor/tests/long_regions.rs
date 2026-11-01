//! Local keys inside one giant region cost work proportional to the edited
//! neighborhood: the counted work at 20,000 lines stays at its 1,000-line size
//! (#314). Each shape keeps exact source after typing, Backspace and Enter.
use futo_notes_editor::{DisplayOffset, DisplayRange, EditWork, EditorSession, ParagraphKey};

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

/// Type `x`, Backspace it, then Enter at the end of the middle line's `needle`.
fn keys(source: &str, needle: &str) -> ([EditWork; 3], String) {
    let mut session = EditorSession::open(source);
    let at = session.display_text().find(needle).unwrap() + needle.len();
    let typed = session
        .replace(session.revision(), caret(at), "x", &mut |_| Ok(()))
        .unwrap()
        .work;
    let deleted = session
        .paragraph_key(
            session.revision(),
            caret(at + 1),
            ParagraphKey::Backspace,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap()
        .work;
    let entered = session
        .paragraph_key(
            session.revision(),
            caret(at),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap()
        .work;
    ([typed, deleted, entered], session.source_text())
}

fn total(work: &EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

#[test]
fn local_keys_in_one_giant_region_do_not_scale_with_it() {
    type Shape = fn(usize) -> (String, String, String);
    let shapes: [(&str, Shape); 1] = [("soft-line paragraph", |lines| {
        let line = |i: usize| format!("word {i}\n");
        let source: String = (0..lines).map(line).collect();
        let middle = format!("word {}", lines / 2);
        let expected = source.replace(&format!("{middle}\n"), &format!("{middle}\n\n"));
        (source, middle, expected)
    })];
    for (name, shape) in shapes {
        let mut small = None;
        for lines in [1_000, 20_000] {
            let (source, needle, expected) = shape(lines);
            let (work, after) = keys(&source, &needle);
            assert_eq!(after, expected, "{name} at {lines}");
            let measured = work.map(|work| total(&work));
            if let Some(small) = small {
                for (key, (large, small)) in measured.iter().zip(small).enumerate() {
                    assert!(
                        *large <= small * 3 / 2 + 1024,
                        "{name} key {key}: {small} at 1k, {large} at 20k"
                    );
                }
            } else {
                assert!(
                    measured.iter().all(|work| *work < 64 * 1024),
                    "{name} {measured:?}"
                );
                small = Some(measured);
            }
        }
    }
}

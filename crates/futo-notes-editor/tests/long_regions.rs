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
    let shapes: [(&str, Shape); 5] = [
        ("fenced code", |lines| {
            let line = |i: usize| format!("code {i}\n");
            let source: String = std::iter::once("```rust\n".to_owned())
                .chain((0..lines).map(line))
                .chain(std::iter::once("```\n".to_owned()))
                .collect();
            let middle = format!("code {}", lines / 2);
            let expected = source.replace(&format!("{middle}\n"), &format!("{middle}\n\n"));
            (source, middle, expected)
        }),
        ("tight bullet list", |lines| {
            let source: String = (0..lines).map(|i| format!("- item {i}\n")).collect();
            let middle = format!("item {}", lines / 2);
            let expected = source.replace(&format!("- {middle}\n"), &format!("- {middle}\n- \n"));
            (source, middle, expected)
        }),
        ("soft-line paragraph", |lines| {
            let line = |i: usize| format!("word {i}\n");
            let source: String = (0..lines).map(line).collect();
            let middle = format!("word {}", lines / 2);
            let expected = source.replace(&format!("{middle}\n"), &format!("{middle}\n\n"));
            (source, middle, expected)
        }),
        ("unterminated HTML comment", |lines| {
            let line = |i: usize| format!("para {i}\n\n");
            let source: String = std::iter::once("<!-- open\n".to_owned())
                .chain((0..lines).map(line))
                .collect();
            let middle = format!("para {}", lines / 2);
            let expected = source.replace(&format!("{middle}\n"), &format!("{middle}\n\n"));
            (source, middle, expected)
        }),
        ("ordered list", |lines| {
            let source: String = (1..=lines).map(|i| format!("{i}. item {i}\n")).collect();
            let half = lines / 2;
            let middle = format!("item {half}");
            let mut expected: String = (1..=half).map(|i| format!("{i}. item {i}\n")).collect();
            expected.push_str(&format!("{}. \n", half + 1));
            expected.extend((half + 1..=lines).map(|i| format!("{}. item {i}\n", i + 1)));
            (source, middle, expected)
        }),
    ];
    for (name, shape) in shapes {
        // Enter in an ordered list renumbers every following item by design.
        let bounded = if name == "ordered list" { 2 } else { 3 };
        let mut small = None;
        for lines in [1_000, 20_000] {
            let (source, needle, expected) = shape(lines);
            let (work, after) = keys(&source, &needle);
            assert_eq!(after, expected, "{name} at {lines}");
            let measured = work.map(|work| total(&work));
            let measured = measured[..bounded].to_vec();
            if let Some(small) = &small {
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

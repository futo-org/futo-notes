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

/// Type `|` (which may edit a table cell), Backspace it, then Enter at the end
/// of the middle line's `needle`.
fn keys(source: &str, needle: &str) -> ([EditWork; 3], String) {
    let mut session = EditorSession::open(source);
    let at = session.display_text().find(needle).unwrap() + needle.len();
    let typed = session
        .replace(session.revision(), caret(at), "|", &mut |_| Ok(()))
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

/// A list of `lines` lines and Enter's expected source at the first leaf
/// item from the middle: a new empty sibling under it.
fn nested_shape(
    lines: usize,
    line: impl Fn(usize) -> String,
    leaf: impl Fn(usize) -> bool,
    depths: &[usize],
) -> (String, String, String) {
    let source: String = (0..lines).map(&line).collect();
    let middle = (lines / 2..).find(|&i| leaf(i)).unwrap();
    let text = line(middle);
    let indent = &text[..text.len() - text.trim_start().len()];
    assert!(depths[middle % depths.len()] > 0 || indent.is_empty());
    let expected = source.replace(&text, &format!("{text}{indent}- \n"));
    (source, format!("n{middle}z"), expected)
}

fn total(work: &EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

#[test]
fn local_keys_in_one_giant_region_do_not_scale_with_it() {
    type Shape = fn(usize) -> (String, String, String);
    let shapes: [(&str, Shape); 8] = [
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
        ("nested list with links", |lines| {
            // Seven levels deep, with links and headings inside items, as in
            // a long nested reference note.
            const DEPTHS: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 5, 6, 4, 5, 3];
            let line = |i: usize| {
                let indent = "    ".repeat(DEPTHS[i % 12]);
                match i % 4 {
                    0 => format!("{indent}- ### Encounters n{i}z\n"),
                    1 => format!("{indent}- 1d4 [owl {i}](https://example.com/owl-{i})s n{i}z\n"),
                    2 => format!("{indent}- **d100** n{i}z\n"),
                    _ => format!("{indent}- {:02}–{:02} n{i}z\n", i % 100, (i + 2) % 100),
                }
            };
            nested_shape(lines, line, |i| i % 12 == 6 && i % 4 != 0, &DEPTHS)
        }),
        ("alternating depth list", |lines| {
            const DEPTHS: [usize; 2] = [0, 1];
            let line = |i: usize| format!("{}- item n{i}z\n", "  ".repeat(i % 2));
            nested_shape(lines, line, |i| i % 2 == 1, &DEPTHS)
        }),
        ("deep nested list", |lines| {
            const DEPTHS: [usize; 7] = [0, 1, 2, 3, 4, 5, 6];
            let line = |i: usize| format!("{}- item n{i}z\n", "    ".repeat(i % 7));
            nested_shape(lines, line, |i| i % 7 == 6, &DEPTHS)
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

/// A paragraph that is one long line, like corpus note 882329: a typed key,
/// Backspace, Enter and the Backspace that rejoins the line cost work near
/// their 2,000-character size at 50,000 characters (word seams, #314). Enter
/// goes after the space that ends the word, so the new line has no indent
/// for the rejoining Backspace to take off.
#[test]
fn keys_in_one_long_line_do_not_scale_with_it() {
    const WORDS: [&str; 8] = [
        "duck",
        "eggs",
        "usually",
        "take",
        "days",
        "to",
        "hatch",
        "incubator",
    ];
    let line = |len: usize| {
        let mut source = String::new();
        let mut i = 0usize;
        while source.len() < len {
            source.push_str(WORDS[i * 7 % WORDS.len()]);
            source.push_str([" ", " , ", " ", " . "][i % 4]);
            i += 1;
        }
        source
    };
    let mut small: Option<Vec<usize>> = None;
    for len in [2_000, 50_000] {
        let source = line(len);
        let mut session = EditorSession::open(&source);
        assert_eq!(session.display_text(), source);
        // The end of a word near the middle.
        let at = len / 2 + source[len / 2..].find(' ').unwrap();
        let mut work = Vec::new();
        let mut expected = source.clone();
        let change = session
            .replace(session.revision(), caret(at), "s", &mut |_| Ok(()))
            .unwrap();
        expected.insert(at, 's');
        work.push(total(&change.work));
        let key = |session: &mut EditorSession, at: usize, key: ParagraphKey| {
            session
                .paragraph_key(session.revision(), caret(at), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap()
                .work
        };
        work.push(total(&key(&mut session, at + 1, ParagraphKey::Backspace)));
        expected.remove(at);
        assert_eq!(session.source_text(), expected, "{len} after Backspace");
        work.push(total(&key(&mut session, at + 1, ParagraphKey::Enter)));
        expected.insert(at + 1, '\n');
        assert_eq!(session.source_text(), expected, "{len} after Enter");
        work.push(total(&key(&mut session, at + 2, ParagraphKey::Backspace)));
        expected.remove(at + 1);
        assert_eq!(session.source_text(), expected, "{len} after rejoining");
        assert_eq!(session.display_text(), expected, "{len} display");
        match &small {
            Some(small) => {
                for (key, (large, small)) in work.iter().zip(small).enumerate() {
                    assert!(
                        *large <= small * 3 / 2 + 1024,
                        "key {key}: {small} at 2k, {large} at 50k ({work:?})"
                    );
                }
            }
            None => {
                assert!(work.iter().all(|work| *work < 64 * 1024), "{work:?}");
                small = Some(work);
            }
        }
    }
}

/// Enter after a nested item, then Backspace on the new empty item, leaves
/// an empty line inside the list (its marker and indent go): each key, and
/// typing after it, stays local (counted work at 20,000 lines stays at its
/// 1,000-line size).
#[test]
fn an_emptied_item_in_a_nested_list_stays_local() {
    const DEPTHS: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 5, 6, 4, 5, 3];
    let line = |i: usize| {
        let indent = "    ".repeat(DEPTHS[i % 12]);
        match i % 4 {
            0 => format!("{indent}- ### Encounters n{i}z\n"),
            1 => format!("{indent}- 1d4 [owl {i}](https://example.com/owl-{i})s n{i}z\n"),
            2 => format!("{indent}- **d100** n{i}z\n"),
            _ => format!("{indent}- {:02}–{:02} n{i}z\n", i % 100, (i + 2) % 100),
        }
    };
    let mut small: Option<Vec<usize>> = None;
    for lines in [1_000, 20_000] {
        let source: String = (0..lines).map(line).collect();
        let middle = (lines / 2..).find(|&i| i % 12 == 6 && i % 4 != 0).unwrap();
        let text = line(middle);
        let mut session = EditorSession::open(&source);
        let needle = format!("n{middle}z");
        let at = session.display_text().find(&needle).unwrap() + needle.len();
        let key = |session: &mut EditorSession, at: usize, key: ParagraphKey| {
            let change = session
                .paragraph_key(session.revision(), caret(at), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            (total(&change.work), change.selection.end.0)
        };
        let (entered, at) = key(&mut session, at, ParagraphKey::Enter);
        let (emptied, at) = key(&mut session, at, ParagraphKey::Backspace);
        assert_eq!(
            session.source_text(),
            source.replacen(&text, &format!("{text}\n"), 1),
            "{lines}"
        );
        let typed = total(
            &session
                .replace(session.revision(), caret(at), "x", &mut |_| Ok(()))
                .unwrap()
                .work,
        );
        let measured = vec![entered, emptied, typed];
        if let Some(small) = &small {
            for (key, (large, small)) in measured.iter().zip(small).enumerate() {
                assert!(
                    *large <= small * 3 / 2 + 1024,
                    "key {key}: {small} at 1k, {large} at 20k"
                );
            }
        } else {
            assert!(
                measured.iter().all(|work| *work < 64 * 1024),
                "{measured:?}"
            );
            small = Some(measured);
        }
    }
}

/// Enter on the empty item Enter just made outdents it (decided 2026-11-02),
/// reading only its parent's list: the counted work of both keys at 20,000
/// lines stays at its 1,000-line size, and the later siblings become its
/// children, renumbered from 1 when ordered.
#[test]
fn outdenting_an_empty_nested_item_reads_only_its_parents_list() {
    const DEPTHS: [usize; 6] = [0, 1, 2, 2, 2, 1];
    for ordered in [false, true] {
        let line = |i: usize| {
            let depth = DEPTHS[i % 6];
            let indent = "    ".repeat(depth);
            // Ordered nested levels under bullets, so no marker width
            // changes the nesting.
            let marker = if ordered && depth > 0 {
                let at = i % 6;
                let number = if depth == 1 {
                    usize::from(at == 5) + 1
                } else {
                    at - 1
                };
                format!("{number}.")
            } else {
                "-".to_owned()
            };
            format!("{indent}{marker} [owl {i}](https://example.com/owl-{i}) n{i}z\n")
        };
        let mut small: Option<Vec<usize>> = None;
        for lines in [1_200, 24_000] {
            let source: String = (0..lines).map(line).collect();
            // The first of three depth-2 siblings, from the middle.
            let middle = (lines / 2..).find(|&i| i % 6 == 2).unwrap();
            let mut session = EditorSession::open(&source);
            let needle = format!("n{middle}z");
            let at = session.display_text().find(&needle).unwrap() + needle.len();
            let mut work = Vec::new();
            let mut caret_at = at;
            for _ in 0..2 {
                let change = session
                    .paragraph_key(
                        session.revision(),
                        caret(caret_at),
                        ParagraphKey::Enter,
                        &mut |_| Ok(()),
                    )
                    .unwrap()
                    .unwrap();
                work.push(total(&change.work));
                caret_at = change.selection.end.0;
            }
            // The empty item sits at depth 1 after the middle item; the two
            // depth-2 items after it are its children.
            let (a, b, c) = (line(middle), line(middle + 1), line(middle + 2));
            let after = if ordered {
                let parent_next = DEPTHS[(middle - 1) % 6] == 1;
                assert!(parent_next);
                let renumber = |text: &str, from: &str, to: &str| text.replacen(from, to, 1);
                format!(
                    "{a}    2. \n{}{}",
                    renumber(&b, "2.", "1."),
                    renumber(&c, "3.", "2.")
                )
            } else {
                format!("{a}    - \n{b}{c}")
            };
            let expected = source.replacen(&format!("{a}{b}{c}"), &after, 1);
            let expected = if ordered {
                // The parent-level item after them moves from 2. to 3.
                let d = line(middle + 3);
                expected.replacen(&d, &d.replacen("2.", "3.", 1), 1)
            } else {
                expected
            };
            let got = session.source_text();
            if got != expected {
                let p = got
                    .bytes()
                    .zip(expected.bytes())
                    .position(|(x, y)| x != y)
                    .unwrap_or(0);
                panic!(
                    "ordered {ordered} at {lines}:\n got  {:?}\n want {:?}",
                    &got[p.saturating_sub(250)..(p + 150).min(got.len())],
                    &expected[p.saturating_sub(250)..(p + 150).min(expected.len())]
                );
            }
            if let Some(small) = &small {
                for (key, (large, small)) in work.iter().zip(small).enumerate() {
                    assert!(
                        *large <= small * 3 / 2 + 1024,
                        "ordered {ordered} key {key}: {small} at 1k, {large} at 20k"
                    );
                }
            } else {
                assert!(work.iter().all(|work| *work < 64 * 1024), "{work:?}");
                small = Some(work);
            }
        }
    }
}

#[path = "long_regions/block_selection.rs"]
mod block_selection;
#[path = "long_regions/list_toggle.rs"]
mod list_toggle;
#[path = "long_regions/quotes.rs"]
mod quotes;

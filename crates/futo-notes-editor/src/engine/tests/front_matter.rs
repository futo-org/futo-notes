//! Front matter: shown as metadata, kept by every edit of the body.
use super::super::Engine;
use super::{ok, range, select, typed};
use crate::{Affinity, DisplayRange, EditorError, InputAction, Revision};

#[test]
fn front_matter_is_metadata_and_the_caret_starts_in_the_body() {
    let source = "---\ntitle: x\ntags: [a, b]\n---\n# Body\n";
    let mut engine = Engine::open(source);
    assert_eq!(engine.display_text(), "title: x\ntags: [a, b]\nBody\n");
    assert_eq!(engine.selection(), range(22, 22));
    let snapped = |engine: &mut Engine, wanted: DisplayRange| {
        engine.select(Revision(0), wanted).unwrap().selection
    };
    assert_eq!(snapped(&mut engine, range(0, 3)), range(22, 22));
    assert_eq!(snapped(&mut engine, range(5, 24)), range(22, 24));
    assert_eq!(snapped(&mut engine, range(0, 27)), range(0, 27));
    assert_eq!(
        engine.replace(Revision(0), range(2, 3), "y", InputAction::Typing, &mut ok),
        Err(EditorError::InvalidRange)
    );
    select(&mut engine, 22, 22, Affinity::Backward);
    typed(&mut engine, "z");
    assert_eq!(
        engine.source_text(),
        "---\ntitle: x\ntags: [a, b]\n---\n# zBody\n"
    );
    for (source, display, written) in [
        ("---\na: 1\n---\n", "a: 1\n", "---\na: 1\n---\nX"),
        ("---\r\na: 1\r\n---", "a: 1\r\n", "---\r\na: 1\r\n---\r\nX"),
        ("---\n---\nbody", "body", "---\n---\nXbody"),
        ("---\na\n", "\u{fffc}\na\n", "---\na\nX"),
    ] {
        let mut engine = Engine::open(source);
        assert_eq!(engine.display_text(), display, "{source:?}");
        let body = engine.selection();
        if source.starts_with("---\na\n") {
            select(
                &mut engine,
                display.len(),
                display.len(),
                Affinity::Backward,
            );
        } else {
            assert_eq!(engine.selection(), body);
        }
        typed(&mut engine, "X");
        assert_eq!(engine.source_text(), written, "{source:?}");
    }
}

/// Select All covers the front matter, and Copy copies it, but every edit
/// over it changes the body only; one Undo restores the exact bytes.
#[test]
fn select_all_edits_the_body_and_keeps_the_front_matter() {
    let source = "---\ntitle: x\n---\nbody\nmore";
    let front = "---\ntitle: x\n---\n";
    type Edit = fn(&mut Engine, DisplayRange) -> Option<String>;
    let edits: [(&str, Edit, &str); 7] = [
        (
            "typing",
            |engine, all| {
                let revision = engine.revision();
                engine
                    .replace(revision, all, "X", InputAction::Typing, &mut ok)
                    .unwrap();
                None
            },
            "X",
        ),
        (
            "Enter",
            |engine, all| {
                let revision = engine.revision();
                engine
                    .key(revision, all, crate::ParagraphKey::Enter, &mut ok)
                    .unwrap();
                None
            },
            "\n",
        ),
        (
            "paste",
            |engine, all| {
                let revision = engine.revision();
                engine
                    .paste_markdown(revision, all, "# p\nq", &mut ok)
                    .unwrap();
                None
            },
            "# p\nq",
        ),
        (
            "Backspace",
            |engine, all| {
                let revision = engine.revision();
                engine
                    .key(revision, all, crate::ParagraphKey::Backspace, &mut ok)
                    .unwrap();
                None
            },
            "",
        ),
        (
            "Delete",
            |engine, all| {
                let revision = engine.revision();
                engine
                    .key(revision, all, crate::ParagraphKey::Delete, &mut ok)
                    .unwrap();
                None
            },
            "",
        ),
        (
            "Cut",
            |engine, all| {
                let revision = engine.revision();
                Some(engine.cut_markdown(revision, all, &mut ok).unwrap().0)
            },
            "",
        ),
        (
            "Copy",
            |engine, all| Some(engine.copy_markdown(engine.revision(), all).unwrap()),
            "body\nmore",
        ),
    ];
    for (name, edit, body) in edits {
        let mut engine = Engine::open(source);
        let all = range(0, engine.display_len());
        assert_eq!(engine.select(Revision(0), all).unwrap().selection, all);
        let copied = edit(&mut engine, all);
        assert_eq!(engine.source_text(), format!("{front}{body}"), "{name}");
        match name {
            "Cut" => assert_eq!(
                copied.as_deref(),
                Some("body\nmore"),
                "Cut copies what it removes"
            ),
            "Copy" => assert_eq!(
                copied.as_deref(),
                Some(source),
                "Copy copies all it selects"
            ),
            _ => {}
        }
        if name != "Copy" {
            engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
            assert_eq!(engine.source_text(), source, "{name}: undo");
        }
    }
    // With an empty body, typing over everything writes the body line.
    let mut engine = Engine::open("---\na: 1\n---");
    let all = range(0, engine.display_len());
    engine.select(Revision(0), all).unwrap();
    engine
        .replace(Revision(0), all, "X", InputAction::Typing, &mut ok)
        .unwrap();
    assert_eq!(engine.source_text(), "---\na: 1\n---\nX");
}

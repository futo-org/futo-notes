//! Tag queries and header-tag edits through the public session.
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision, SourceEdit};
mod common;
use common::ReferenceView;

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

fn add(source: &str, tag: &str) -> String {
    let mut session = EditorSession::open(source);
    session
        .add_header_tag(Revision(0), tag, &mut |_| Ok(()))
        .unwrap();
    session.source_text()
}

fn remove(source: &str, tag: &str) -> String {
    let mut session = EditorSession::open(source);
    session
        .remove_header_tag(Revision(0), tag, &mut |_| Ok(()))
        .unwrap();
    session.source_text()
}

#[test]
fn queries_follow_the_canonical_tag_rules() {
    let long = format!("#{} #{}", "a".repeat(50), "b".repeat(51));
    let source = format!(
        "#Project #project\n#todo\n\n#2fast word#no #Yes, `#code` #yes\n```\n#fenced\n```\n{long}"
    );
    let session = EditorSession::open(&source);
    assert_eq!(session.header_tags(), ["#project", "#todo"]);
    assert_eq!(
        session.tags(),
        [
            "#project",
            "#todo",
            "#yes",
            &format!("#{}", "a".repeat(50))[..]
        ]
    );
    // A tag line must be tags only: prose on the first line is not a header.
    assert!(EditorSession::open("#a text\n#b").header_tags().is_empty());
    // Front matter is metadata, not a tag source.
    let fm = EditorSession::open("---\n#yaml\n---\n#h\n\nbody #b");
    assert_eq!(fm.header_tags(), ["#h"]);
    assert_eq!(fm.tags(), ["#h", "#b"]);
}

#[test]
fn add_spells_canonically_and_touches_only_the_header() {
    for (source, tag, expected) in [
        ("body", "Work Stuff", "#work_stuff\n\nbody"),
        ("", "#a", "#a"),
        ("body\r\nmore", "a", "#a\r\n\r\nbody\r\nmore"),
        // A lone CR is an ordinary character, not a line ending.
        ("body\rmore", "a", "#a\n\nbody\rmore"),
        ("#a\r#b", "c", "#a\r#b #c"),
        ("#a\n\nbody", " #B ", "#a #b\n\nbody"),
        ("#a   \n#b  \nbody", "c", "#a   \n#b #c  \nbody"),
        ("#a\n\nbody #c", "c", "#a #c\n\nbody #c"),
        ("#a\n\nbody", "A", "#a\n\nbody"),
        // Front matter stays untouched; the header block starts the body.
        (
            "---\ntags: x\n---\nbody",
            "a",
            "---\ntags: x\n---\n#a\n\nbody",
        ),
    ] {
        assert_eq!(add(source, tag), expected, "{source:?} + {tag:?}");
    }
    let mut session = EditorSession::open("x");
    // A stale revision is reported before the name is judged.
    assert!(matches!(
        session.add_header_tag(Revision(9), "9lives", &mut |_| Ok(())),
        Err(futo_notes_editor::EditorError::StaleRevision { .. })
    ));
    for bad in ["", "9lives", "has/slash", &"a".repeat(51)] {
        assert!(session
            .add_header_tag(Revision(0), bad, &mut |_| Ok(()))
            .is_err());
    }
}

#[test]
fn remove_deletes_every_spelling_and_keeps_other_bytes() {
    for (source, tag, expected) in [
        ("#a #b\n\nbody", "b", "#a\n\nbody"),
        ("#a #b\n\nbody", "#A", "#b\n\nbody"),
        ("  #a  #b  #a\r\n#c\n\nbody", "a", "  #b\r\n#c\n\nbody"),
        ("#a\n#b\n\nbody", "a", "#b\n\nbody"),
        ("#a\r#b", "a", "#b"),
        ("#a\n\nbody", "a", "body"),
        ("#a", "a", ""),
        ("#a\n\nbody #a", "z", "#a\n\nbody #a"),
        ("#a\n\nbody #a", "a", "body #a"),
    ] {
        assert_eq!(remove(source, tag), expected, "{source:?} - {tag:?}");
    }
}

#[test]
fn edits_keep_selection_history_and_recovery() {
    let original = "#a #b\n\nbody text";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    let mut accepted: Vec<SourceEdit> = Vec::new();
    session.select(Revision(0), caret(12)).unwrap();
    view.apply(
        session
            .add_header_tag(Revision(0), "c", &mut |e| {
                accepted.push(e.clone());
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "#a #b #c\n\nbody text");
    assert_eq!(view.text, session.display_text());
    assert_eq!(session.selection(), caret(15));
    // Unchanged requests accept nothing and add no history.
    assert!(session
        .add_header_tag(Revision(1), "C", &mut |_| panic!("no record"))
        .unwrap()
        .is_none());
    view.apply(
        session
            .remove_header_tag(Revision(1), "a", &mut |e| {
                accepted.push(e.clone());
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "#b #c\n\nbody text");
    assert_eq!(session.selection(), caret(12));
    // Recovery replays the accepted records onto the opening source.
    let mut recovered = EditorSession::open(original);
    for edit in &accepted {
        recovered.replay(edit).unwrap();
    }
    assert_eq!(recovered.source_text(), session.source_text());
    // Undo/redo walk the two edits byte-exactly and restore the caret.
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "#a #b #c\n\nbody text");
    assert_eq!(session.selection(), caret(15));
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), caret(12));
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "#a #b #c\n\nbody text");
    assert_eq!(view.text, session.display_text());
}

#[test]
fn edit_work_does_not_scale_with_the_note() {
    let body = "line of ordinary prose\n\n".repeat(10_000);
    let mut session = EditorSession::open(&format!("#a\n\n{body}"));
    let add = session
        .add_header_tag(Revision(0), "b", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let remove = session
        .remove_header_tag(Revision(1), "a", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    for change in [add, remove] {
        assert!(change.work.parsed_source_bytes < 4_096, "{:?}", change.work);
        assert!(
            change.work.materialized_source_bytes < 4_096,
            "{:?}",
            change.work
        );
    }
}

/// The note list and search read tags with `futo_notes_tags::extract_tags`,
/// which must agree with the line reader about what is code and what is front
/// matter. Excluded, because the tags crate does not read them: `[` and `<`
/// (a backtick taken by a wikilink, autolink or link destination) and `|`
/// (table cells, which end a code span).
#[test]
fn the_tags_crate_reads_code_and_front_matter_as_the_line_reader_does() {
    let pieces = [
        "`", "``", "```", "~~~", "#a", "#b", "#", "a", " ", "\t", "\n", "\r\n", "\r", "\\", "---",
        "- ", "> ", "# ", "    ", ".",
    ];
    let mut state: u32 = 0x7a67_c0de;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as usize
    };
    for _ in 0..20_000 {
        let len = next() % 18;
        let source: String = (0..len).map(|_| pieces[next() % pieces.len()]).collect();
        assert_eq!(
            EditorSession::open(&source).tags(),
            futo_notes_tags::extract_tags(&source),
            "{source:?}"
        );
    }
}

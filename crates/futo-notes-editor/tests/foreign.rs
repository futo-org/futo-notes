//! Front matter, HTML-looking text and unfamiliar Markdown keep their exact bytes, and
//! edits beside them never reinterpret them (#300).
mod common;
use common::ReferenceView;
use futo_notes_editor::*;

fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

fn accept(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

/// The incremental projection equals a fresh open of the same source.
fn assert_fresh(session: &EditorSession) {
    let shown = session.display_text();
    let fresh = EditorSession::open(&session.source_text());
    assert_eq!(fresh.display_text(), shown);
    let all = range(0, shown.len());
    let mut incremental = session.project(session.revision(), all).unwrap();
    incremental.revision = Revision(0);
    assert_eq!(incremental, fresh.project(Revision(0), all).unwrap());
}

fn blocks(session: &EditorSession) -> Vec<BlockDescription> {
    let all = range(0, session.display_text().len());
    session.project(session.revision(), all).unwrap().blocks
}

fn type_at_end(session: &mut EditorSession, text: &str) {
    let end = session.display_text().len();
    session
        .replace(session.revision(), range(end, end), text, &mut accept)
        .unwrap();
}

#[test]
fn front_matter_is_inert_metadata_and_the_caret_starts_in_the_body() {
    let source = "---\ntitle: x\ntags: [a, b]\n---\n# Body\n";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("title: x\ntags: [a, b]\nBody\n");
    assert_eq!(session.display_text(), view.text);
    // Each line is its own block: both metadata lines are described as metadata.
    let described = blocks(&session);
    assert!(described[0].metadata && described[1].metadata);
    assert_eq!(described[0].range, range(0, 8));
    assert_eq!(described[1].range, range(9, 21));
    assert_eq!((described[2].heading, described[2].metadata), (1, false));
    assert_eq!(session.selection(), range(22, 22));

    // Selection never rests inside metadata; select-all still covers it.
    let snapped = |session: &mut EditorSession, wanted| {
        session.select(Revision(0), wanted).unwrap().selection
    };
    assert_eq!(snapped(&mut session, range(0, 3)), range(22, 22));
    assert_eq!(snapped(&mut session, range(5, 24)), range(22, 24));
    assert_eq!(snapped(&mut session, range(0, 27)), range(0, 27));

    // Edits that would touch part of the metadata reject before acceptance.
    let mut accepted = 0;
    let mut counting = |_: &SourceEdit| {
        accepted += 1;
        Ok(())
    };
    assert_eq!(
        session.replace(Revision(0), range(2, 3), "y", &mut counting),
        Err(EditorError::InvalidRange)
    );
    let mut paragraph = EditorSession::open("---\na\n---\nb");
    assert_eq!(
        paragraph.paragraph_key(
            Revision(0),
            range(2, 2),
            ParagraphKey::Backspace,
            &mut counting
        ),
        Ok(None)
    );
    assert_eq!(accepted, 0);

    view.apply(
        session
            .replace(Revision(0), range(22, 22), "z", &mut accept)
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "---\ntitle: x\ntags: [a, b]\n---\n# zBody\n"
    );
    assert_eq!(view.text, "title: x\ntags: [a, b]\nzBody\n");
    assert_fresh(&session);
    view.apply(session.undo(Revision(1), &mut accept).unwrap().unwrap());
    assert_eq!(session.source_text(), source);
    assert_fresh(&session);
}

#[test]
fn only_the_exact_front_matter_shape_is_metadata() {
    // Empty metadata has nothing to show, so it has no description.
    for (source, shown, described) in [
        ("---\n[a]: /x\n---\n[a]\n", "[a]: /x\n[a]\n", true),
        ("---\n---\nbody\n", "body\n", false),
    ] {
        let mut session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown, "{source:?}");
        assert_eq!(blocks(&session)[0].metadata, described, "{source:?}");
        let all = range(0, shown.len());
        assert!(session.project(Revision(0), all).unwrap().links.is_empty());
        type_at_end(&mut session, "!");
        assert_eq!(session.source_text(), format!("{source}!"));
        assert_fresh(&session);
    }
    // Line 1 must be exactly `---`: a BOM or spaces after it make no front matter.
    for source in [
        "\u{feff}--- \r\na: 1\r\n\r\nb: [x]\r\n---\t\r\nbody",
        "----\na\n---\n",
        " ---\na\n---\n",
        "---\na\n",
        "+++\na\n+++\n",
        "x\n\n---\na\n---\n",
        "---\na\n ---\n",
    ] {
        let session = EditorSession::open(source);
        assert!(
            blocks(&session).iter().all(|block| !block.metadata),
            "{source:?}"
        );
    }
}

#[test]
fn a_metadata_only_note_has_an_editable_empty_body() {
    for (source, shown, typed) in [
        ("---\na: 1\n---\n", "a: 1\n", "---\na: 1\n---\nX"),
        ("---\r\na: 1\r\n---", "a: 1\r\n", "---\r\na: 1\r\n---\r\nX"),
    ] {
        let mut session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown);
        let body = session.selection();
        assert_eq!(body.start.0, session.display_text().len());
        session
            .replace(Revision(0), body, "X", &mut accept)
            .unwrap();
        assert_eq!(session.source_text(), typed);
        assert!(blocks(&session)[0].metadata);
        assert_fresh(&session);
    }
}

#[test]
fn front_matter_appears_and_disappears_only_through_its_own_fences() {
    // An unclosed opener is a divider; a recorded closer makes metadata.
    let mut session = EditorSession::open("---\ntitle: [x]\n\nbody *b*\n");
    assert_eq!(session.display_text(), "\u{fffc}\ntitle: [x]\n\nbody b\n");
    session
        .replay(&SourceEdit {
            previous_revision: Revision(0),
            revision: Revision(1),
            range: SourceRange {
                start: SourceOffset(15),
                end: SourceOffset(15),
            },
            removed: String::new(),
            inserted: "---".into(),
        })
        .unwrap();
    assert_eq!(session.source_text(), "---\ntitle: [x]\n---\nbody *b*\n");
    assert_eq!(session.display_text(), "title: [x]\nbody b\n");
    assert_fresh(&session);
    // Deleting the body leaves the metadata. (A selection covering all of it takes the
    // metadata too: engine::tests::front_matter_is_metadata_and_the_caret_starts_in_the_body.)
    let change = session
        .replace(Revision(1), range(11, 18), "", &mut accept)
        .unwrap();
    assert_eq!(session.source_text(), "---\ntitle: [x]\n---\n");
    assert_eq!(change.selection, range(11, 11));
    assert_fresh(&session);
    // A recorded closer deletion turns it back into Markdown.
    session
        .replay(&SourceEdit {
            previous_revision: Revision(2),
            revision: Revision(3),
            range: SourceRange {
                start: SourceOffset(15),
                end: SourceOffset(19),
            },
            removed: "---\n".into(),
            inserted: String::new(),
        })
        .unwrap();
    assert_eq!(session.display_text(), "\u{fffc}\ntitle: [x]\n");
    assert_fresh(&session);

    // Body typing never rescans or copies the metadata.
    let body = "\n\nfirst\n\nsecond\n";
    let work = |source: &str, at: usize| {
        let mut session = EditorSession::open(source);
        let change = session
            .replace(Revision(0), range(at, at), "x", &mut accept)
            .unwrap();
        (
            change.work.parsed_source_bytes,
            change.work.materialized_source_bytes,
        )
    };
    let metadata = format!("---\n{}---{body}", "key: value\n".repeat(200));
    let shown = EditorSession::open(&metadata).display_text();
    assert_eq!(work(&metadata, shown.len() - 2), work(body, body.len() - 4));
}

#[test]
fn footnotes_references_and_unfamiliar_markdown_stay_visible_and_exact() {
    for (source, shown) in [
        (
            "x[^1] and \\[^1]\n\n[^1]: note\n  lazy\n\n    second\n",
            "x[^1] and [^1]\n\n[^1]: note\nlazy\n\nsecond\n",
        ),
        // A reference definition is literal text, and so is the reference.
        ("[a]\n\n[a]: /x \"t\"\n", "[a]\n\n[a]: /x \"t\"\n"),
        (
            "| a | b |\n|---|---|\n| 1 | 2 |\n",
            "| a | b |\n|---|---|\n| 1 | 2 |\n",
        ),
        (
            "Term\n: def\n\n[[Wiki]] ^block\n",
            "Term\n: def\n\n[[Wiki]] ^block\n",
        ),
    ] {
        let mut session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown, "{source:?}");
        type_at_end(&mut session, "!");
        assert_eq!(session.source_text(), format!("{source}!"));
        assert_fresh(&session);
    }
}

#[test]
fn malformed_and_representative_notes_open_nonblank_exact_and_editable() {
    for source in [
        "<div",
        "<!-- never closed\n\n# x\n",
        "\u{feff}plain",
        "---\n",
        "a\0b",
        "[unclosed](",
        "**",
        "</pre>\n\n```\nx\n",
        "---\ntitle: Groceries\n---\n\n- milk\n  - skim\n\n> <kbd>q</kbd>\n\n<details>\n<summary>s</summary>\n\nhidden *md*\n\n</details>\n\n[^n]: foot\n",
    ] {
        let mut session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert!(!session.display_text().is_empty(), "{source:?}");
        assert_fresh(&session);
        let end = session.display_text().len();
        let before = session.source_text();
        session
            .replace(Revision(0), range(end, end), "\u{2318}", &mut accept)
            .unwrap();
        assert!(
            session.source_text().contains('\u{2318}')
                && session.source_text().len() == before.len() + 3,
            "{source:?}"
        );
        assert_fresh(&session);
    }
}

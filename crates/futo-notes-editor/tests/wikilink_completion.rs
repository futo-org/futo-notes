//! Wikilink completion: the engine decides the open `[[` run, candidates and
//! replacement; a consumer only requests, accepts or walks away.
use futo_notes_editor::*;
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| id.to_string()).collect()
}

const VAULT: &[&str] = &[
    "Projects/Roadmap",
    "Other/Notes",
    "Work/Notes",
    "Ünï/İstanbul",
];

fn editor(source: &str, caret: usize) -> EditorSession {
    let mut editor = EditorSession::open(source);
    editor.update_note_ids(&ids(VAULT));
    editor.select(Revision(0), range(caret, caret)).unwrap();
    editor
}

fn offered(editor: &EditorSession) -> Option<(DisplayRange, String, Vec<String>)> {
    editor
        .wikilink_completion(editor.revision())
        .unwrap()
        .map(|c| {
            (
                c.range,
                c.query,
                c.candidates.into_iter().map(|n| n.note_id).collect(),
            )
        })
}

#[test]
fn the_open_run_and_its_candidates_follow_the_existing_rules() {
    let all = ids(VAULT);
    for (source, caret, expected) in [
        ("a [[Ro", 6, Some((2, 6, "Ro", vec!["Projects/Roadmap"]))),
        // Empty and whitespace-padded queries; folded, case-insensitive substring.
        (
            "[[",
            2,
            Some((0, 2, "", all.iter().map(String::as_str).collect())),
        ),
        (
            "[[ NOTES ",
            9,
            Some((0, 9, " NOTES ", vec!["Other/Notes", "Work/Notes"])),
        ),
        ("[[i", 3, Some((0, 3, "i", vec!["Ünï/İstanbul"]))),
        // No match still reports the run so a consumer can remember a dismissal.
        ("[[zzz", 5, Some((0, 5, "zzz", vec![]))),
        // A completed link earlier on the line does not reopen; the new `[[` does.
        (
            "[[a]] and [[Wo",
            14,
            Some((10, 14, "Wo", vec!["Work/Notes"])),
        ),
        // An auto-closed `]]` after the caret is consumed by the replacement.
        (
            "x [[Ro]] y",
            6,
            Some((2, 8, "Ro", vec!["Projects/Roadmap"])),
        ),
        // The query is the source text typed after `[[`, markup included.
        ("[[*zz", 5, Some((0, 5, "*zz", vec![]))),
        // A multi-byte character after the caret is not a closing `]]`.
        ("[[Roé", 4, Some((0, 4, "Ro", vec!["Projects/Roadmap"]))),
        ("[[a]]", 5, None),
        ("[[a]] b", 7, None),
        ("no brackets", 4, None),
        ("[Ro", 3, None),
        // An unclosed backtick is literal text, not code.
        ("`[[Ro", 5, Some((1, 5, "Ro", vec!["Projects/Roadmap"]))),
        ("`[[Ro` x", 4, None),
        ("```\n[[Ro", 4, None),
        // An indented line is not code (its indent is not shown); HTML-looking text is plain.
        ("    [[Ro", 4, Some((0, 4, "Ro", vec!["Projects/Roadmap"]))),
        ("\\[[Ro", 4, None),
        ("<div>\n[[Ro", 10, Some((6, 10, "Ro", vec!["Projects/Roadmap"]))),
        ("[[a\n[[Ro", 8, Some((4, 8, "Ro", vec!["Projects/Roadmap"]))),
        ("[[Ro\nnext", 9, None),
    ] {
        let editor = editor(source, caret);
        let got = offered(&editor);
        let expected = expected.map(|(from, to, query, notes)| {
            (
                range(from, to),
                query.to_owned(),
                notes.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            )
        });
        assert_eq!(got, expected, "{source:?} @{caret}");
        assert_eq!(editor.source_text(), source);
    }

    // A run longer than 512 source bytes is not offered; bytes, not characters.
    for unit in ["x", "é"] {
        let source = format!("[[{}", unit.repeat(300));
        let caret = source.len();
        let long = editor(&source, caret);
        assert_eq!(offered(&long).is_some(), unit == "x", "{unit}");
    }

    // Labels use the shortest unique suffix; the full id is detail when it differs.
    let editor = editor("[[o", 3);
    let found = editor.wikilink_completion(Revision(0)).unwrap().unwrap();
    let rows: Vec<_> = found
        .candidates
        .iter()
        .map(|c| (c.label.as_str(), c.detail.as_deref()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Roadmap", Some("Projects/Roadmap")),
            ("Other/Notes", None),
            ("Work/Notes", None)
        ]
    );
    // A range selection or an open composition offers nothing.
    let mut selecting = editor_with_selection();
    assert_eq!(offered(&selecting), None);
    selecting.select(Revision(0), range(4, 4)).unwrap();
    selecting.compose(Revision(0), range(4, 4), "か").unwrap();
    assert_eq!(offered(&selecting), None);
}

fn editor_with_selection() -> EditorSession {
    let mut editor = EditorSession::open("[[Ro");
    editor.update_note_ids(&ids(VAULT));
    editor.select(Revision(0), range(0, 4)).unwrap();
    editor
}

#[test]
fn candidate_lists_are_capped() {
    let many: Vec<String> = (0..50).map(|n| format!("Dir/note{n}")).collect();
    let mut editor = EditorSession::open("[[note");
    editor.update_note_ids(&many);
    editor.select(Revision(0), range(6, 6)).unwrap();
    let found = editor.wikilink_completion(Revision(0)).unwrap().unwrap();
    assert_eq!(found.candidates.len(), 20);
    assert_eq!(found.candidates[0].note_id, "Dir/note0");
}

#[test]
fn accepting_replaces_only_the_run_with_one_undoable_action() {
    for (source, caret, saved, caret_after) in [
        ("a [[Ro b", 6, "a [[Projects/Roadmap]] b", 22),
        ("x [[Ro]] y", 6, "x [[Projects/Roadmap]] y", 22),
        ("[[", 2, "[[Projects/Roadmap]]", 20),
    ] {
        let mut editor = editor(source, caret);
        let mut view = ReferenceView::new(&editor.display_text());
        let found = editor.wikilink_completion(Revision(0)).unwrap().unwrap();
        let mut accepted = Vec::new();
        view.apply(
            editor
                .accept_wikilink_completion(
                    Revision(0),
                    found.range,
                    &found.query,
                    "Projects/Roadmap",
                    &mut |edit| {
                        accepted.push(edit.clone());
                        Ok(())
                    },
                )
                .unwrap(),
        );
        assert_eq!(editor.source_text(), saved);
        assert_eq!(accepted.len(), 1, "one recovery record");
        assert_eq!(view.text, editor.display_text());
        assert_eq!(editor.selection(), range(caret_after, caret_after));
        let role = editor
            .project(Revision(1), range(0, editor.display_text().len()))
            .unwrap()
            .wikilinks;
        assert_eq!(role[0].note_id.as_deref(), Some("Projects/Roadmap"));

        // One Undo restores the typed run and its caret; Redo repeats the link.
        view.apply(editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), source);
        assert_eq!(editor.selection(), range(caret, caret));
        view.apply(editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), saved);
    }
}

#[test]
fn stale_or_unacceptable_claims_are_rejected_without_a_change() {
    let claim = |source: &str, caret| {
        let editor = editor(source, caret);
        let found = editor.wikilink_completion(Revision(0)).unwrap().unwrap();
        (editor, found)
    };
    let id = "Projects/Roadmap";
    let accept = |editor: &mut EditorSession, revision, found: &WikilinkCompletion, id| {
        let mut recorded = 0;
        let result = editor.accept_wikilink_completion(
            Revision(revision),
            found.range,
            &found.query,
            id,
            &mut |_| {
                recorded += 1;
                Ok(())
            },
        );
        assert_eq!(recorded, usize::from(result.is_ok()));
        result
    };

    // An edit after the request.
    let (mut e, found) = claim("[[Ro", 4);
    e.replace(Revision(0), range(4, 4), "a", &mut |_| Ok(()))
        .unwrap();
    assert!(matches!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::StaleRevision { .. })
    ));
    // The caret moved off the run without an edit.
    let (mut e, found) = claim("[[Ro", 4);
    e.select(Revision(0), range(1, 1)).unwrap();
    assert!(matches!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::StaleClaim)
    ));
    // A claim for a different query or range.
    let (mut e, found) = claim("[[Ro", 4);
    let wrong = WikilinkCompletion {
        query: "R".into(),
        ..found.clone()
    };
    assert!(matches!(
        accept(&mut e, 0, &wrong, id),
        Err(EditorError::StaleClaim)
    ));
    // The note disappeared (or never existed) after note ids changed.
    let (mut e, found) = claim("[[Ro", 4);
    e.update_note_ids(&ids(&["Other/Notes"]));
    assert!(matches!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::StaleClaim)
    ));
    // An id that cannot be written as a wikilink; a composition in progress.
    let (mut e, found) = claim("[[Ro", 4);
    e.update_note_ids(&ids(&["a]]b", id]));
    assert!(matches!(
        accept(&mut e, 0, &found, "a]]b"),
        Err(EditorError::InvalidText)
    ));
    let (mut e, found) = claim("[[Ro", 4);
    e.compose(Revision(0), range(4, 4), "か").unwrap();
    assert!(matches!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::CompositionActive)
    ));
    assert_eq!(e.source_text(), "[[Ro");

    // Cancelling is not calling accept: requests leave no state behind, and an
    // id added after the request is still acceptable.
    let (mut e, found) = claim("[[Ro", 4);
    assert_eq!(e.revision(), Revision(0));
    e.update_note_ids(&ids(&[id, "Late/Note"]));
    assert!(accept(&mut e, 0, &found, "Late/Note").is_ok());
    assert_eq!(e.source_text(), "[[Late/Note]]");
}

//! Wikilink roles: canonical targets, shortest-unique labels, unresolved state,
//! code/HTML isolation and note-id delivery to a live session.
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

/// (visible glyphs, canonical target, label, resolved note id)
type Role = (String, String, String, Option<String>);

fn roles(editor: &EditorSession) -> Vec<Role> {
    let display = editor.display_text();
    editor
        .project(editor.revision(), range(0, display.len()))
        .unwrap()
        .wikilinks
        .into_iter()
        .map(|link| {
            (
                display[link.range.start.0..link.range.end.0].to_owned(),
                link.target,
                link.label,
                link.note_id,
            )
        })
        .collect()
}

fn role(glyphs: &str, target: &str, label: &str, id: Option<&str>) -> Role {
    (
        glyphs.into(),
        target.into(),
        label.into(),
        id.map(Into::into),
    )
}

const VAULT: &[&str] = &["Projects/Roadmap", "Other/Notes", "Work/Notes", "a|b"];

#[test]
fn targets_labels_and_unresolved_links_follow_the_canonical_rules() {
    for (source, expected) in [
        (
            "see [[Projects/Roadmap]] ok",
            vec![role(
                "[[Projects/Roadmap]]",
                "Projects/Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        // A bare leaf resolves to its one owner and shows its unique suffix.
        (
            "[[Roadmap]]",
            vec![role(
                "[[Roadmap]]",
                "Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        // Ambiguous and absent targets are both unresolved and show the raw target.
        (
            "[[Notes]] [[Nope]]",
            vec![
                role("[[Notes]]", "Notes", "Notes", None),
                role("[[Nope]]", "Nope", "Nope", None),
            ],
        ),
        (
            "[[Work/Notes]]",
            vec![role(
                "[[Work/Notes]]",
                "Work/Notes",
                "Work/Notes",
                Some("Work/Notes"),
            )],
        ),
        // A leading `!` stays text; `|` and inner `[[` belong to the whole target.
        ("![[a|b]]", vec![role("[[a|b]]", "a|b", "a|b", Some("a|b"))]),
        (
            "[[x[[Roadmap]]",
            vec![role("[[x[[Roadmap]]", "x[[Roadmap", "x[[Roadmap", None)],
        ),
        (
            "[[Nope]]] [[]] [[a\nb]]",
            vec![role("[[Nope]]", "Nope", "Nope", None)],
        ),
        // Markdown-looking text inside the brackets is target text and shows as typed.
        (
            "[[*Nope*]]",
            vec![role("[[*Nope*]]", "*Nope*", "*Nope*", None)],
        ),
    ] {
        let mut editor = EditorSession::open(source);
        editor.update_note_ids(&ids(VAULT));
        assert_eq!(roles(&editor), expected, "{source:?}");
        assert_eq!(editor.source_text(), source);
    }
}

#[test]
fn code_escapes_and_front_matter_are_isolated() {
    for source in [
        "`[[Roadmap]]`",
        "```\n[[Roadmap]]\n```",
        "\\[[Roadmap]]",
        "---\ntitle: [[Roadmap]]\n---\n",
    ] {
        let mut editor = EditorSession::open(source);
        editor.update_note_ids(&ids(VAULT));
        assert_eq!(roles(&editor), vec![], "{source:?}");
    }
    // An indented line is not code, HTML-looking lines are plain lines, and a wikilink is
    // read before link syntax.
    for source in [
        "    [[Roadmap]]",
        "<div>\n[[Roadmap]]\n</div>",
        "[[Roadmap]](https://x.test)",
    ] {
        let mut editor = EditorSession::open(source);
        editor.update_note_ids(&ids(VAULT));
        assert_eq!(
            roles(&editor),
            vec![role(
                "[[Roadmap]]",
                "Roadmap",
                "Roadmap",
                Some("Projects/Roadmap")
            )],
            "{source:?}"
        );
    }
    let mut editor = EditorSession::open("`[[x]]` [[Roadmap]]");
    editor.update_note_ids(&ids(VAULT));
    assert_eq!(
        roles(&editor),
        vec![role(
            "[[Roadmap]]",
            "Roadmap",
            "Roadmap",
            Some("Projects/Roadmap")
        )]
    );
}

type Edit = (
    &'static str,
    (usize, usize),
    &'static str,
    &'static str,
    Vec<Role>,
);

#[test]
fn edits_at_link_boundaries_keep_exact_bytes_and_current_roles() {
    // (source, display range, inserted, saved source, roles after the edit)
    let cases: &[Edit] = &[
        (
            "a [[Roadmap",
            (11, 11),
            "]]",
            "a [[Roadmap]]",
            vec![role(
                "[[Roadmap]]",
                "Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        ("a [[Roadmap]] b", (12, 13), "", "a [[Roadmap] b", vec![]),
        ("a [[Roadmap]] b", (2, 3), "", "a [Roadmap]] b", vec![]),
        (
            "[[Notes]]",
            (2, 2),
            "Work/",
            "[[Work/Notes]]",
            vec![role(
                "[[Work/Notes]]",
                "Work/Notes",
                "Work/Notes",
                Some("Work/Notes"),
            )],
        ),
        (
            "[[Roadmap]]",
            (11, 11),
            "x",
            "[[Roadmap]]x",
            vec![role(
                "[[Roadmap]]",
                "Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        (
            "[[Roadmap]]",
            (0, 0),
            "`",
            "`[[Roadmap]]",
            vec![role(
                "[[Roadmap]]",
                "Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        ("`[[Roadmap]]", (12, 12), "`", "`[[Roadmap]]`", vec![]),
        ("x [[Roadmap]] y", (1, 4), "z", "xzRoadmap]] y", vec![]),
    ];
    for (source, (start, end), inserted, saved, expected) in cases {
        let mut editor = EditorSession::open(source);
        editor.update_note_ids(&ids(VAULT));
        let mut view = ReferenceView::new(&editor.display_text());
        view.apply(
            editor
                .replace_action(
                    Revision(0),
                    range(*start, *end),
                    inserted,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(editor.source_text(), *saved, "{source:?}");
        assert_eq!(view.text, editor.display_text());
        assert_eq!(roles(&editor), *expected, "{source:?}");
        view.apply(editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), *source);
        assert_eq!(view.text, editor.display_text());
    }
}

#[test]
fn note_ids_reach_a_composing_session_and_change_only_affected_regions() {
    let source = "[[Roadmap]] one\n\nplain [[Other]]\n\nab cd [[Notes]]";
    let mut editor = EditorSession::open(source);
    assert_eq!(
        roles(&editor)
            .iter()
            .map(|r| r.3.clone())
            .collect::<Vec<_>>(),
        vec![None, None, None],
        "no catalog yet: every link is unresolved"
    );
    editor.update_note_ids(&ids(&["Projects/Roadmap", "Other"]));
    let view = ReferenceView::new(&editor.display_text());
    let caret = source.find(" cd").unwrap();
    editor.select(Revision(0), range(caret, caret)).unwrap();
    editor
        .compose(Revision(0), range(caret, caret), "か")
        .unwrap();

    // Adding an unrelated note and a second Roadmap changes only the first link.
    let change = editor.update_note_ids(&ids(&[
        "Projects/Roadmap",
        "Archive/Roadmap",
        "Other",
        "Elsewhere",
    ]));
    assert_eq!(change.revision, Revision(0));
    assert_eq!(change.projections.len(), 1);
    assert_eq!(change.projections[0].text, "[[Roadmap]]");
    assert_eq!(change.projections[0].wikilinks[0].note_id, None);
    assert_eq!(editor.display_text(), view.text);
    assert_eq!(editor.selection(), range(caret, caret));
    assert_eq!(editor.composition().unwrap().text, "か");

    // A full-path link becomes resolved and shows its new unique suffix.
    let change = editor.update_note_ids(&ids(&["Projects/Roadmap", "Other", "Work/Notes"]));
    let changed: Vec<_> = change.projections.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(changed, vec!["[[Roadmap]]", "[[Notes]]"]);
    assert_eq!(
        roles(&editor)[2],
        role("[[Notes]]", "Notes", "Notes", Some("Work/Notes"))
    );

    // The same ids again do no work; a repeated id is still one note.
    let same = ids(&["Projects/Roadmap", "Other", "Work/Notes"]);
    let change = editor.update_note_ids(&same);
    assert!(change.projections.is_empty() && change.work.catalog_items == 0);
    let before = roles(&editor);
    let repeated = ids(&[
        "Projects/Roadmap",
        "Projects/Roadmap",
        "Other",
        "Work/Notes",
    ]);
    assert!(editor.update_note_ids(&repeated).projections.is_empty());
    assert_eq!(roles(&editor), before);

    editor
        .commit_composition(Revision(0), None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        editor.source_text(),
        "[[Roadmap]] one\n\nplain [[Other]]\n\nabか cd [[Notes]]"
    );
    assert_eq!(roles(&editor)[2].3.as_deref(), Some("Work/Notes"));
    editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), source);
    editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    let saved = editor.source_text();
    // Recovery replays bytes; the note ids are delivered again, not recorded.
    let mut recovered = EditorSession::restore(&saved, Revision(3));
    recovered.update_note_ids(&ids(&["Projects/Roadmap", "Other", "Work/Notes"]));
    assert_eq!(roles(&recovered), roles(&editor));
}

#[test]
fn note_id_maintenance_visits_only_rows_whose_links_it_can_change() {
    let work = |paragraphs: usize| {
        let mut source = String::from("[[Roadmap]]\n\n");
        for index in 0..paragraphs {
            source.push_str(&format!("line {index} of plain prose\n\n"));
            if index % (paragraphs / 16) == 0 {
                source.push_str(&format!("[[Topic {index}]]\n\n"));
            }
        }
        let mut editor = EditorSession::open(&source);
        editor.update_note_ids(&ids(&["Projects/Roadmap"]));
        let change = editor.update_note_ids(&ids(&["Projects/Roadmap", "Archive/Roadmap"]));
        assert_eq!(change.projections.len(), 1);
        change.work
    };
    for work in [work(1_000), work(20_000)] {
        assert!(
            work.rows_visited < 128 && work.links_examined <= 4,
            "{work:?}"
        );
    }
}

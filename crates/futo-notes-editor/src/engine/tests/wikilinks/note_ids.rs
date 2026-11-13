//! Note-id deliveries and note-link targets.
use super::*;

#[test]
fn note_ids_restyle_only_the_links_they_change_and_touch_nothing_else() {
    let source = "[[Roadmap]] one\n\nplain [[Other]]\n\nab cd [[Notes]]";
    let mut engine = Engine::open(source);
    engine.update_note_ids(&ids(&["Projects/Roadmap", "Other"]));
    let display = engine.display_text();
    let caret = source.find(" cd").unwrap();
    engine.select(Revision(0), range(caret, caret)).unwrap();
    engine
        .compose(Revision(0), range(caret, caret), "か")
        .unwrap();

    // An unrelated note and a second Roadmap change only the first link.
    let change = engine.update_note_ids(&ids(&[
        "Projects/Roadmap",
        "Archive/Roadmap",
        "Other",
        "Elsewhere",
    ]));
    assert_eq!(change.revision, Revision(0));
    assert_eq!(change.projections.len(), 1);
    assert_eq!(change.projections[0].text, "[[Roadmap]]");
    assert_eq!(change.projections[0].wikilinks[0].note_id, None);
    assert_eq!(engine.display_text(), display);
    assert_eq!(engine.selection(), range(caret, caret));
    assert_eq!(engine.composition().unwrap().text, "か");
    assert!(!engine.can_undo());

    // A leaf link becomes resolved and shows its new unique suffix.
    let change = engine.update_note_ids(&ids(&["Projects/Roadmap", "Other", "Work/Notes"]));
    let changed: Vec<_> = change.projections.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(changed, vec!["[[Roadmap]]", "[[Notes]]"]);
    assert_eq!(
        roles(&engine)[2],
        role("[[Notes]]", "Notes", "Notes", Some("Work/Notes"))
    );

    // The same ids again do no work; a repeated id is still one note.
    let same = ids(&["Projects/Roadmap", "Other", "Work/Notes"]);
    let change = engine.update_note_ids(&same);
    assert!(change.projections.is_empty() && change.work.catalog_items == 0);
    let before = roles(&engine);
    let repeated = ids(&[
        "Projects/Roadmap",
        "Projects/Roadmap",
        "Other",
        "Work/Notes",
    ]);
    assert!(engine.update_note_ids(&repeated).projections.is_empty());
    assert_eq!(roles(&engine), before);

    engine
        .commit_composition(Revision(0), None, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(
        engine.source_text(),
        "[[Roadmap]] one\n\nplain [[Other]]\n\nabか cd [[Notes]]"
    );
    assert_eq!(roles(&engine)[2].3.as_deref(), Some("Work/Notes"));
    engine.undo(Revision(1), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), source);
}

/// A note of `paragraphs` prose lines with 16 links spread through it and a
/// `[[Roadmap]]` at the top; the work of adding a second Roadmap.
fn delivery_work(paragraphs: usize) -> crate::NoteIdWork {
    let mut source = String::from("[[Roadmap]]\n\n");
    for index in 0..paragraphs {
        source.push_str(&format!("line {index} of plain prose\n\n"));
        if index % (paragraphs / 16) == 0 {
            source.push_str(&format!("[[Topic {index}]]\n\n"));
        }
    }
    let mut engine = Engine::open(&source);
    engine.update_note_ids(&ids(&["Projects/Roadmap"]));
    let change = engine.update_note_ids(&ids(&["Projects/Roadmap", "Archive/Roadmap"]));
    assert_eq!(change.projections.len(), 1);
    change.work
}

#[test]
fn a_note_id_delivery_visits_only_lines_whose_links_it_can_change() {
    // The old engine entered 7 row-tree nodes for 1,000 paragraphs and 9
    // for 20,000, examining 1 link; the core enters 75 and 85 (tree nodes
    // plus the lines of the one chunk whose link bits match), examining 1.
    // Both stay under the old test's bound of 128 nodes and 4 links.
    for paragraphs in [1_000, 20_000] {
        let work = delivery_work(paragraphs);
        assert!(
            work.rows_visited < 128 && work.links_examined <= 4,
            "{paragraphs}: {work:?}"
        );
    }
}

#[test]
fn links_typed_into_a_long_note_are_found_by_a_later_delivery() {
    let mut engine = Engine::open(&"prose line\n".repeat(5_000));
    engine.update_note_ids(&ids(&["A/Roadmap"]));
    let at = engine.display_len() / 2;
    engine.select(Revision(0), range(at, at)).unwrap();
    for ch in "[[Roadmap]]".chars() {
        let selection = engine.selection();
        engine
            .replace(
                engine.revision(),
                selection,
                &ch.to_string(),
                InputAction::Typing,
                &mut ok,
            )
            .unwrap();
    }
    assert_eq!(roles(&engine)[0].3.as_deref(), Some("A/Roadmap"));
    let change = engine.update_note_ids(&ids(&["A/Roadmap", "B/Roadmap"]));
    assert_eq!(change.projections.len(), 1);
    assert_eq!(change.projections[0].wikilinks[0].note_id, None);
    // Deleting it leaves nothing for the next delivery to find.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    let change = engine.update_note_ids(&ids(&["A/Roadmap"]));
    assert!(change.projections.is_empty());
    assert_eq!(change.work.links_examined, 0);
}

#[test]
fn note_links_resolve_against_the_delivered_ids() {
    let engine = with_ids("x", &["Projects/Roadmap", "Projects/Plan"]);
    assert_eq!(
        engine.resolve_note_link("Projects/Plan", "Roadmap.md"),
        Some("Projects/Roadmap".to_owned())
    );
    assert_eq!(engine.resolve_note_link("Projects/Plan", "Nope"), None);
    assert_eq!(
        engine.normalize_link_destination("Projects/Plan", "example.com"),
        "https://example.com"
    );
    assert_eq!(
        engine.normalize_link_destination("Projects/Plan", "Roadmap"),
        "Roadmap"
    );
}

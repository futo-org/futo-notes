//! Tag queries and header-tag edits.
use super::*;

#[test]
fn tag_queries_read_the_lines_tag_marks() {
    let long = format!("#{} #{}", "a".repeat(50), "b".repeat(51));
    let source = format!(
        "#Project #project\n#todo\n\n#2fast word#no #Yes, `#code` #yes\n```\n#fenced\n```\n{long}"
    );
    let engine = Engine::open(&source);
    assert_eq!(engine.header_tags(), ["#project", "#todo"]);
    assert_eq!(
        engine.tags(),
        [
            "#project",
            "#todo",
            "#yes",
            &format!("#{}", "a".repeat(50))[..]
        ]
    );
    // A tag line holds tags only.
    assert!(Engine::open("#a text\n#b").header_tags().is_empty());
    // Front matter is metadata, not a tag source.
    let engine = Engine::open("---\n#yaml\n---\n#h\n\nbody #b");
    assert_eq!(engine.header_tags(), ["#h"]);
    assert_eq!(engine.tags(), ["#h", "#b"]);
    // Tags in headings, lists, quotes, tables and indented lines count;
    // a tag in a link's destination or a URL does not.
    let engine = Engine::open(
        "# Head #h\n- item #l\n> quote #q\n| cell #t |\n|---|\n    indented #i\n[x](#no) https://x.y/#no",
    );
    assert_eq!(engine.tags(), ["#h", "#l", "#q", "#t", "#i"]);
    assert!(Engine::open("").tags().is_empty());
}

#[test]
fn header_tag_edits_check_revision_name_and_composition() {
    let mut engine = Engine::open("x");
    assert!(matches!(
        engine.add_header_tag(Revision(9), "9lives", &mut ok),
        Err(EditorError::StaleRevision { .. })
    ));
    for bad in ["", "9lives", "has/slash", &"a".repeat(51)] {
        assert_eq!(
            engine.add_header_tag(Revision(0), bad, &mut ok),
            Err(EditorError::InvalidText),
            "{bad:?}"
        );
    }
    engine.select(Revision(0), range(1, 1)).unwrap();
    engine.compose(Revision(0), range(1, 1), "か").unwrap();
    assert_eq!(
        engine.add_header_tag(Revision(0), "a", &mut ok),
        Err(EditorError::CompositionActive)
    );
    let mut engine = Engine::open("#a\n\nx");
    assert!(engine
        .remove_header_tag(Revision(0), "a", &mut |_| Err("no".into()))
        .is_err());
    assert_eq!(engine.source_text(), "#a\n\nx");
    assert!(!engine.can_undo());
}

#[test]
fn header_tag_work_stays_in_the_header() {
    let body = "line of ordinary prose\n\n".repeat(10_000);
    let mut engine = Engine::open(&format!("#a\n\n{body}"));
    let add = engine
        .add_header_tag(Revision(0), "b", &mut ok)
        .unwrap()
        .unwrap();
    let remove = engine
        .remove_header_tag(Revision(1), "a", &mut ok)
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

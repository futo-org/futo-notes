//! Current Typing completion retains full nonidentity escape atoms at its prefix.
use super::*;

#[test]
fn extended_word_prefix_retains_escape_atoms_literal_suffix_and_exact_old_lifetime() {
    let opening = "<www.x.test/a*b*c";
    let opening_source = r"<www.x.test/a\*b\*c";
    let shown = "<www.x.test/a*b*cz. ";
    let candidate = r"<[www.x.test/a\*b\*cz](<http://www.x.test/a*b*cz>). ";
    let old = EditorSession::open(opening_source);
    assert_eq!(old.display_text(), opening);
    let before = old.project(Revision(0), range(0, opening.len())).unwrap();
    assert!(before.links.is_empty());
    assert!(before.runs.iter().all(|run| run.formats.is_empty()));
    let fresh = EditorSession::open(candidate);
    assert_eq!(fresh.display_text(), shown);
    let expected = fresh
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected.range, range(1, opening.len() + 1));
    assert_eq!(expected.destination, "http://www.x.test/a*b*cz");
    assert!(fresh
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .runs
        .iter()
        .all(|run| run.formats.is_empty()));
    let mut editor = EditorSession::open("");
    editor
        .replace(Revision(0), range(0, 0), opening, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(editor.source_text(), opening_source);
    editor.select(Revision(1), range(0, 0)).unwrap();
    editor
        .select(Revision(1), range(opening.len(), opening.len()))
        .unwrap();
    editor
        .replace(
            Revision(1),
            range(opening.len(), opening.len()),
            "z. ",
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(editor.source_text(), candidate);
    assert_eq!(editor.display_text(), shown);
    assert_eq!(editor.selection(), range(shown.len(), shown.len()));
    assert_eq!(
        editor
            .inspect_link(Revision(2), range(1, 2))
            .unwrap()
            .unwrap(),
        expected
    );
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), opening_source);
    assert!(editor
        .project(Revision(3), range(0, opening.len()))
        .unwrap()
        .links
        .is_empty());
    editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), candidate);
    editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap();
    // Undo restores the unchanged old immutable payload, rather than the newly
    // completed suffix/meaning. A plain ending must verify that original URI.
    editor.select(Revision(5), range(0, 0)).unwrap();
    editor
        .select(Revision(5), range(opening.len(), opening.len()))
        .unwrap();
    editor
        .replace(
            Revision(5),
            range(opening.len(), opening.len()),
            " ",
            &mut |_| Ok(()),
        )
        .unwrap();
    let old_link = editor
        .inspect_link(Revision(6), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(old_link.range, range(1, opening.len()));
    assert_eq!(old_link.destination, "http://www.x.test/a*b*c");
    assert_eq!(editor.display_text(), format!("{opening} "));
}

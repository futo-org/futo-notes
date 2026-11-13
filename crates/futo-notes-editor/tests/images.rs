//! Image and divider atoms: roles, caret stops, insertion and stale claims,
//! with literal source, history and recovery records.
use futo_notes_editor::*;
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn atoms(editor: &EditorSession) -> Vec<AtomDescription> {
    let end = editor.display_text().len();
    editor
        .project(editor.revision(), range(0, end))
        .unwrap()
        .atoms
}

/// (kind, visible glyphs, alt, destination, title, reference, vault)
type Role = (
    AtomKind,
    String,
    Option<(String, String, Option<String>, Option<String>, bool)>,
);

fn roles(editor: &EditorSession) -> Vec<Role> {
    let display = editor.display_text();
    atoms(editor)
        .into_iter()
        .map(|atom| {
            assert_eq!(
                (atom.before, atom.after),
                (atom.range.start, atom.range.end)
            );
            (
                atom.kind,
                display[atom.range.start.0..atom.range.end.0].to_owned(),
                atom.image
                    .map(|i| (i.alt, i.destination, i.title.or(i.reference), None, i.vault)),
            )
        })
        .collect()
}

fn image(glyphs: &str, alt: &str, destination: &str, extra: Option<&str>, vault: bool) -> Role {
    (
        AtomKind::Image,
        glyphs.into(),
        Some((
            alt.into(),
            destination.into(),
            extra.map(Into::into),
            None,
            vault,
        )),
    )
}

#[test]
fn atom_roles_keep_spelling_and_classify_vault_references() {
    for (source, expected) in [
        (
            // Nothing inside an image is read: its alt shows its asterisks.
            "a ![alt *x*](image-1.png) b",
            vec![image(
                "![alt *x*](image-1.png)",
                "alt *x*",
                "image-1.png",
                None,
                true,
            )],
        ),
        (
            "![](<my pic.png> \"T\")",
            vec![image(
                "![](<my pic.png> \"T\")",
                "",
                "my pic.png",
                Some("T"),
                true,
            )],
        ),
        (
            "![x](https://x.test/a.png) ![y](note.md)",
            vec![
                image(
                    "![x](https://x.test/a.png)",
                    "x",
                    "https://x.test/a.png",
                    None,
                    false,
                ),
                image("![y](note.md)", "y", "note.md", None, false),
            ],
        ),
        (
            "a\n\n---\n\nb",
            vec![(AtomKind::Divider, "\u{fffc}".into(), None)],
        ),
        // Code, escapes and reference-style images (not read) are not atoms.
        ("`![a](b.png)` \\![a](b.png) ![u][nope]", vec![]),
        ("![r][id] and ![c][]\n\n[id]: pics/a.png\n[c]: c.PNG", vec![]),
        ("```\n![a](b.png)\n```", vec![]),
    ] {
        let editor = EditorSession::open(source);
        assert_eq!(roles(&editor), expected, "{source:?}");
        assert_eq!(editor.source_text(), source);
    }
}

#[test]
fn deleting_an_atom_replaces_its_range_and_undo_restores_exact_bytes() {
    let source = "x ![a](b.png) y";
    let mut editor = EditorSession::open(source);
    let atom = atoms(&editor).remove(0);
    let mut view = ReferenceView::new(&editor.display_text());
    view.apply(
        editor
            .replace_action(
                Revision(0),
                atom.range,
                "",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(editor.source_text(), "x  y");
    assert!(atoms(&editor).is_empty());
    view.apply(editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), source);
    assert_eq!(roles(&editor).len(), 1);
}

fn insert(
    editor: &mut EditorSession,
    claim: ImageClaim,
    reference: &str,
    alt: &str,
) -> Result<Option<ViewChange>, EditorError> {
    let revision = editor.revision();
    editor.insert_image(revision, claim, reference, alt, &mut |_| Ok(()))
}

#[test]
fn insertion_is_one_history_action_with_the_caret_after_the_image() {
    for (source, selection, saved, glyphs) in [
        ("", (0, 0), "![](image-9.png)", "![](image-9.png)"),
        ("ab cd", (2, 2), "ab![](image-9.png) cd", "![](image-9.png)"),
        // A selection is replaced by the image.
        ("ab cd", (1, 4), "a![](image-9.png)d", "![](image-9.png)"),
        // A hidden-marker boundary follows the caret's affinity.
        (
            "**ab** cd",
            (2, 2),
            "**ab![](image-9.png)** cd",
            "![](image-9.png)",
        ),
    ] {
        let mut editor = EditorSession::open(source);
        editor
            .select(Revision(0), range(selection.0, selection.1))
            .unwrap();
        let claim = editor.image_claim();
        let mut view = ReferenceView::new(&editor.display_text());
        let mut records = Vec::new();
        view.apply(
            editor
                .insert_image(Revision(0), claim, "image-9.png", "", &mut |edit| {
                    records.push(edit.clone());
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(editor.source_text(), saved, "{source:?}");
        assert_eq!(records.len(), 1, "one recovery record");
        assert_eq!(view.text, editor.display_text());
        let found = atoms(&editor);
        assert_eq!(found.len(), 1);
        assert_eq!(
            &editor.display_text()[found[0].range.start.0..found[0].range.end.0],
            glyphs
        );
        assert_eq!(
            editor.selection(),
            range(found[0].after.0, found[0].after.0)
        );

        view.apply(editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), source);
        assert_eq!(editor.selection(), range(selection.0, selection.1));
        view.apply(editor.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), saved);
    }

    // The stored reference round-trips exactly, including spaces and an alt.
    let mut editor = EditorSession::open("");
    let claim = editor.image_claim();
    insert(&mut editor, claim, "pics/my pic (1).PNG", "a *b*")
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "![a *b*](<pics/my pic (1).PNG>)");
    let found = atoms(&editor).remove(0).image.unwrap();
    assert_eq!(
        (found.alt.as_str(), found.destination.as_str(), found.vault),
        ("a *b*", "pics/my pic (1).PNG", true)
    );
}

#[test]
fn stale_claims_and_unwritable_inserts_change_nothing() {
    let mut editor = EditorSession::open("ab");
    let claim = editor.image_claim();
    // Ordinary edits do not expire a claim: the image lands at the caret now.
    editor
        .replace(Revision(0), range(2, 2), "c", &mut |_| Ok(()))
        .unwrap();
    editor.select(Revision(1), range(1, 1)).unwrap();
    insert(&mut editor, claim, "image-1.png", "")
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "a![](image-1.png)bc");

    // Another note's session, or the same note reopened, cannot use the claim.
    let mut other = EditorSession::open("ab");
    let reopened = EditorSession::open(&editor.source_text());
    assert!(matches!(
        insert(&mut other, claim, "image-1.png", ""),
        Err(EditorError::StaleClaim)
    ));
    assert!(matches!(
        insert(&mut other, reopened.image_claim(), "image-1.png", ""),
        Err(EditorError::StaleClaim)
    ));

    let claim = other.image_claim();
    for (reference, alt) in [
        ("https://x.test/a.png", ""),
        ("note.md", ""),
        ("", ""),
        ("a<b.png", ""),
        ("a\nb.png", ""),
        ("a\\b.png", ""),
        ("image-1.png", "x]"),
        ("image-1.png", "x\n"),
        ("image-1.png", "a`b"),
    ] {
        assert!(
            matches!(
                insert(&mut other, claim, reference, alt),
                Err(EditorError::InvalidText)
            ),
            "{reference:?} {alt:?}"
        );
    }
    assert!(matches!(
        other.insert_image(Revision(7), claim, "image-1.png", "", &mut |_| Ok(())),
        Err(EditorError::StaleRevision { .. })
    ));
    other.compose(Revision(0), range(2, 2), "か").unwrap();
    assert!(matches!(
        insert(&mut other, claim, "image-1.png", ""),
        Err(EditorError::CompositionActive)
    ));
    assert_eq!(other.source_text(), "ab");

    // A refused acceptance leaves source and history alone; code takes no image.
    let mut editor = EditorSession::open("ab");
    let claim = editor.image_claim();
    let refused = editor.insert_image(Revision(0), claim, "image-1.png", "", &mut |_| {
        Err("disk".into())
    });
    assert!(matches!(refused, Err(EditorError::Persistence(_))));
    assert_eq!(editor.source_text(), "ab");
    assert!(editor.undo(Revision(0), &mut |_| Ok(())).unwrap().is_none());
    for (source, caret) in [("```\nab\n```", 1), ("`ab`", 1)] {
        let mut editor = EditorSession::open(source);
        editor.select(Revision(0), range(caret, caret)).unwrap();
        let claim = editor.image_claim();
        assert!(insert(&mut editor, claim, "image-1.png", "")
            .unwrap()
            .is_none());
        assert_eq!(editor.source_text(), source);
    }
}

#[test]
fn enter_on_a_selected_image_adds_a_line_below_it_and_keeps_the_image() {
    for (source, selected, expected, caret) in [
        ("x\n\n![](a.png)", range(3, 13), "x\n\n![](a.png)\n", 14),
        ("![](a.png)\n\ny", range(0, 10), "![](a.png)\n\n\ny", 11),
    ] {
        let mut editor = EditorSession::open(source);
        editor.select(editor.revision(), selected).unwrap();
        editor
            .paragraph_key(
                editor.revision(),
                selected,
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), expected, "{source:?}");
        assert_eq!(editor.selection(), range(caret, caret));
    }
}

fn caret_key(source: &str, at: usize, key: ParagraphKey) -> (String, usize) {
    let mut editor = EditorSession::open(source);
    let change = editor
        .paragraph_key(editor.revision(), range(at, at), key, &mut |_| Ok(()))
        .unwrap();
    assert!(
        change.is_some(),
        "{key:?} at {at} in {source:?} changed nothing"
    );
    let after = editor.selection().start.0;
    (editor.source_text(), after)
}

#[test]
fn a_carets_backspace_or_delete_next_to_an_image_removes_it_whole() {
    let source = "a ![alt](p.png) b";
    // Display "a ![alt](p.png) b": the image is bytes 2..13.
    let display = EditorSession::open(source).display_text();
    let start = display.find('!').unwrap();
    let end = start + "![alt](p.png)".len();
    assert_eq!(caret_key(source, end, ParagraphKey::Backspace).0, "a  b");
    assert_eq!(caret_key(source, start, ParagraphKey::Delete).0, "a  b");
    // Ordinary text keeps one-grapheme deletion.
    assert_eq!(
        caret_key(source, 1, ParagraphKey::Backspace).0,
        " ![alt](p.png) b"
    );
}

#[test]
fn deleting_an_image_whole_is_one_undo_step() {
    let mut editor = EditorSession::open("x![](p.png)y");
    let end = "x![](p.png)".len();
    editor
        .paragraph_key(
            editor.revision(),
            range(end, end),
            ParagraphKey::Backspace,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "xy");
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "x![](p.png)y");
}

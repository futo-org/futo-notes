//! Image insertion and the keys around an image. The literal cases are
//! `tests/fixtures/engine/images.json`: `before` and `after` are source with
//! the selection marked by `‸` (a caret) or `«…»` (a range), since `|`, `[`
//! and `]` are Markdown here.
use super::super::Engine;
use super::{ok, range};
use crate::lines::Kind;
use crate::{
    AtomKind, DisplayRange, EditorError, EditorSession, ImageClaim, ParagraphKey, Revision,
    ViewChange,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    #[serde(default)]
    reference: String,
    #[serde(default)]
    alt: String,
    after: Option<String>,
    error: Option<String>,
}

/// Source text and the source selection its markers name.
fn marked(text: &str) -> (String, std::ops::Range<usize>) {
    if let Some(at) = text.find('‸') {
        return (text.replacen('‸', "", 1), at..at);
    }
    let start = text.find('«').expect("a selection marker");
    let source = text.replacen('«', "", 1);
    let end = source.find('»').expect("a selection end");
    (source.replacen('»', "", 1), start..end)
}

/// `engine`'s text with its selection marked, in source offsets.
fn marking(engine: &Engine) -> String {
    let mut text = engine.source_text();
    let selection = engine.source_selection(engine.selection());
    if selection.is_empty() {
        text.insert(selection.start, '‸');
    } else {
        text.insert(selection.end, '»');
        text.insert(selection.start, '«');
    }
    text
}

fn run(engine: &mut Engine, case: &Case) -> Result<Option<ViewChange>, EditorError> {
    let revision = engine.revision();
    let selection = engine.selection();
    let key = match case.command.as_str() {
        "insert" => return engine.insert_image(revision, &case.reference, &case.alt, &mut ok),
        "Backspace" => ParagraphKey::Backspace,
        "Delete" => ParagraphKey::Delete,
        "Enter" => ParagraphKey::Enter,
        other => panic!("unknown command {other:?}"),
    };
    engine.key(revision, selection, key, &mut ok)
}

#[test]
fn image_cases() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/fixtures/engine/images.json")).unwrap();
    assert!(cases.len() >= 40);
    for case in &cases {
        let name = &case.name;
        let (source, selection) = marked(&case.before);
        let mut engine = Engine::open(&source);
        engine.land(selection, None);
        let before = engine.selection();
        let before_marked = marking(&engine);
        assert_eq!(
            before_marked, case.before,
            "{name}: the case's selection lands"
        );
        let result = run(&mut engine, case);
        match (&case.error, &case.after) {
            (Some(error), _) => {
                let got = format!("{:?}", result.as_ref().err());
                assert_eq!(got, format!("Some({error})"), "{name}");
                assert_eq!(marking(&engine), case.before, "{name}: unchanged");
                assert!(!engine.can_undo(), "{name}: no history");
            }
            (None, None) => {
                let result = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
                assert!(result.is_none(), "{name}: nothing changes");
                assert_eq!(marking(&engine), case.before, "{name}: unchanged");
                assert!(!engine.can_undo(), "{name}: no history");
            }
            (None, Some(after)) => {
                let change = result
                    .unwrap_or_else(|error| panic!("{name}: {error:?}"))
                    .expect(name);
                assert_eq!(marking(&engine), *after, "{name}");
                assert_eq!(change.selection, engine.selection(), "{name}");
                let fresh = Engine::open(&engine.source_text());
                assert_eq!(engine.display_text(), fresh.display_text(), "{name}");
                // One undo step restores the exact bytes and selection.
                let revision = engine.revision();
                engine.undo(revision, &mut ok).unwrap().expect(name);
                assert_eq!(engine.source_text(), source, "{name}: undo");
                assert_eq!(engine.selection(), before, "{name}: undo selection");
                assert!(!engine.can_undo(), "{name}: one undo step");
                let revision = engine.revision();
                engine.redo(revision, &mut ok).unwrap().expect(name);
                assert_eq!(engine.source_text(), marked(after).0, "{name}: redo");
            }
        }
    }
}

#[test]
fn an_inserted_image_keeps_its_line_the_block_it_was() {
    for (source, at) in [
        ("# Title", 7),
        ("- item", 6),
        ("> quote", 7),
        ("3) x", 4),
        ("| a | b |\n|---|---|", 3),
    ] {
        let mut engine = Engine::open(source);
        engine.land(at..at, None);
        let line = &engine.line(0).line;
        let kind = (line.kind.clone(), line.quote);
        engine
            .insert_image(engine.revision(), "image-1.png", "", &mut ok)
            .unwrap()
            .unwrap();
        let line = &engine.line(0).line;
        assert_eq!((line.kind.clone(), line.quote), kind, "{source:?}");
        assert!(kind.1 > 0 || !matches!(kind.0, Kind::Plain { .. }));
    }
}

#[test]
fn an_insertion_is_an_isolated_undo_step_after_typing() {
    let mut engine = Engine::open("");
    super::typed(&mut engine, "a");
    super::typed(&mut engine, "b");
    engine
        .insert_image(engine.revision(), "image-1.png", "", &mut ok)
        .unwrap()
        .unwrap();
    super::typed(&mut engine, "c");
    assert_eq!(engine.source_text(), "ab![](image-1.png)c");
    for expected in ["ab![](image-1.png)", "ab", ""] {
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), expected);
    }
}

#[test]
fn an_inserted_image_is_an_atom_with_the_caret_after_it() {
    let mut engine = Engine::open("a  b");
    engine.land(2..2, None);
    let change = engine
        .insert_image(engine.revision(), "pics/my pic.png", "x", &mut ok)
        .unwrap()
        .unwrap();
    let atoms: Vec<_> = change
        .projection
        .atoms
        .iter()
        .filter(|atom| atom.kind == AtomKind::Image)
        .collect();
    assert_eq!(atoms.len(), 1);
    let atom = atoms[0];
    let spelled = "![x](<pics/my pic.png>)";
    assert_eq!(atom.range, range(2, 2 + spelled.len()));
    assert_eq!(
        (atom.before, atom.after),
        (atom.range.start, atom.range.end)
    );
    assert_eq!(engine.selection(), range(atom.after.0, atom.after.0));
    let image = atom.image.as_ref().unwrap();
    assert_eq!(
        (image.alt.as_str(), image.destination.as_str(), image.vault),
        ("x", "pics/my pic.png", true)
    );
}

#[test]
fn insertion_refuses_stale_revisions_composition_and_refused_acceptance() {
    let mut engine = Engine::open("ab");
    assert!(matches!(
        engine.insert_image(Revision(7), "image-1.png", "", &mut ok),
        Err(EditorError::StaleRevision { .. })
    ));
    engine.compose(Revision(0), range(2, 2), "か").unwrap();
    assert!(matches!(
        engine.insert_image(Revision(0), "image-1.png", "", &mut ok),
        Err(EditorError::CompositionActive)
    ));
    assert_eq!(engine.source_text(), "ab");

    let mut engine = Engine::open("ab");
    let refused = engine.insert_image(Revision(0), "image-1.png", "", &mut |_| Err("disk".into()));
    assert!(matches!(refused, Err(EditorError::Persistence(_))));
    assert_eq!(engine.source_text(), "ab");
    assert_eq!(engine.selection(), range(0, 0));
    assert!(!engine.can_undo());
}

#[test]
fn a_claim_names_its_session_and_survives_ordinary_edits() {
    let insert = |editor: &mut EditorSession, claim: ImageClaim| {
        let revision = editor.revision();
        editor.insert_image(revision, claim, "image-1.png", "", &mut ok)
    };
    let mut editor = EditorSession::open("ab");
    let claim = editor.image_claim();
    editor
        .replace(Revision(0), range(2, 2), "c", &mut ok)
        .unwrap();
    editor.select(Revision(1), range(1, 1)).unwrap();
    insert(&mut editor, claim).unwrap().unwrap();
    assert_eq!(editor.source_text(), "a![](image-1.png)bc");

    let mut other = EditorSession::open("ab");
    let reopened = EditorSession::open(&editor.source_text());
    assert!(matches!(
        insert(&mut other, claim),
        Err(EditorError::StaleClaim)
    ));
    assert!(matches!(
        insert(&mut other, reopened.image_claim()),
        Err(EditorError::StaleClaim)
    ));
    assert_eq!(other.source_text(), "ab");
    let claim = other.image_claim();
    assert!(insert(&mut other, claim).unwrap().is_some());
}

#[test]
fn deleting_a_selected_image_is_ordinary_input() {
    let mut engine = Engine::open("x ![a](b.png) y");
    let image: DisplayRange = range(2, 13);
    engine
        .replace(
            engine.revision(),
            image,
            "",
            crate::InputAction::Isolated,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "x  y");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "x ![a](b.png) y");
}

#[test]
fn an_image_shows_its_spelling_and_only_inline_images_are_atoms() {
    for (source, expected) in [
        (
            "a ![alt *x*](image-1.png) b",
            vec![(
                "![alt *x*](image-1.png)",
                "alt *x*",
                "image-1.png",
                None,
                true,
            )],
        ),
        (
            "![](<my pic.png> \"T\")",
            vec![("![](<my pic.png> \"T\")", "", "my pic.png", Some("T"), true)],
        ),
        (
            "![x](https://x.test/a.png) ![y](note.md)",
            vec![
                (
                    "![x](https://x.test/a.png)",
                    "x",
                    "https://x.test/a.png",
                    None,
                    false,
                ),
                ("![y](note.md)", "y", "note.md", None, false),
            ],
        ),
        (
            "`![a](b.png)` \\![a](b.png) ![[n]] ![r][id]\n\n[id]: a.png",
            vec![],
        ),
        ("```\n![a](b.png)\n```", vec![]),
    ] {
        let engine = Engine::open(source);
        let display = engine.display_text();
        let end = display.len();
        let slice = engine.project(engine.revision(), range(0, end)).unwrap();
        let found: Vec<_> = slice
            .atoms
            .iter()
            .map(|atom| {
                assert_eq!(atom.kind, AtomKind::Image);
                assert_eq!(
                    (atom.before, atom.after),
                    (atom.range.start, atom.range.end)
                );
                let image = atom.image.as_ref().unwrap();
                assert_eq!(image.reference, None);
                (
                    &display[atom.range.start.0..atom.range.end.0],
                    image.alt.as_str(),
                    image.destination.as_str(),
                    image.title.as_deref(),
                    image.vault,
                )
            })
            .collect();
        assert_eq!(found, expected, "{source:?}");
    }
}

/// iOS sim: after Backspace removed an image and Undo restored it, an arrow
/// step left the view's caret one glyph inside the image's hidden source, and
/// typing wrote `![](image-1.jpgQ)`. An atom's only caret stops are its edges:
/// input at a caret inside an image lands at the nearer edge.
#[test]
fn input_never_lands_inside_an_image() {
    let image = "![](image-1.jpg)";
    let source = format!("here{image} x");
    let (start, end) = (4, 4 + image.len());
    let input = |at: DisplayRange, text: &str, action| {
        let mut engine = Engine::open(&source);
        engine
            .replace(engine.revision(), at, text, action, &mut ok)
            .unwrap()
            .unwrap();
        engine.source_text()
    };
    use crate::InputAction::{Isolated, Typing};
    // One glyph inside its end (the arrow step), and one inside its start.
    assert_eq!(
        input(range(end - 1, end - 1), "Q", Typing),
        format!("here{image}Q x")
    );
    assert_eq!(
        input(range(start + 1, start + 1), "Q", Typing),
        format!("hereQ{image} x")
    );
    // A text service's insertion at a caret there too.
    assert_eq!(
        input(range(end - 2, end - 2), "ab", Isolated),
        format!("here{image}ab x")
    );
    // A composition committed there lands outside it too.
    let mut engine = Engine::open(&source);
    let revision = engine.revision();
    engine
        .compose(revision, range(end - 1, end - 1), "か")
        .unwrap();
    engine
        .commit_composition(revision, None, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), format!("here{image}か x"));
}

/// #393: input from a text service can reach the engine with either boundary
/// inside the hidden image spelling. Replacement takes the whole atom.
#[test]
fn partial_image_selection_is_atomic() {
    let source = "x ![i](p) y";
    for (selected, expected) in [
        (range(5, 11), "x Q"),
        (range(0, 5), "Q y"),
        (range(4, 6), "x Q y"),
    ] {
        for action in [crate::InputAction::Typing, crate::InputAction::Isolated] {
            let mut engine = Engine::open(source);
            engine
                .replace(engine.revision(), selected, "Q", action, &mut ok)
                .unwrap();
            assert_eq!(engine.source_text(), expected);
            engine.undo(engine.revision(), &mut ok).unwrap();
            assert_eq!(engine.source_text(), source);
        }
    }
}

#[test]
fn partial_image_link_selection_is_atomic() {
    let source = "x ![i](p) y";
    let mut engine = Engine::open(source);
    engine
        .set_link_view(engine.revision(), range(5, 11), "U", &mut ok)
        .unwrap();
    assert_eq!(
        engine.source_text(),
        "x [![i](p) y](U)",
        "a link includes the whole image"
    );
}

//! Current origins include earlier deletion and every nested semantic generation.
use super::*;
use futo_notes_editor::{DisplayReplacement, InputAction};

#[test]
fn prior_delete_and_nested_winner_use_changes_keep_the_current_normalized_reference() {
    const ORIGINAL: &str = "cut\n\n[É  ID]: /first 'First' extra\n\n[one][é\tid] [two][É ID]\n\nbody\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    const OPENING: &str = "[É  ID]: /first 'First' extra\n\n[one][é\tid] [two][É ID]\n\nbody\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    const MARKED: &str = "[É  ID]: /first 'First'\n\n[one][é\tid] [two][É ID]\n\nbody\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    const CHANGED: &str = "[É  ID]: /first 'First'\n\n [two][É ID]\n\nBODY\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    const LINKED: &str = "[É  ID]: /first 'First'\n\n [two](</third> \"First\")\n\nBODY\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    let canonical = EditorSession::open(CHANGED);
    assert_eq!(
        canonical.display_text(),
        " two\n\nBODY\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail"
    );
    let winner = canonical
        .inspect_link(Revision(0), range(1, 4))
        .unwrap()
        .unwrap();
    assert_eq!(winner.destination, "/first");
    assert_eq!(winner.title.as_deref(), Some("First"));
    let final_view = EditorSession::open(LINKED);
    let mut editor = EditorSession::open(ORIGINAL);
    editor
        .replace_action(
            Revision(0),
            range(0, 5),
            "",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(editor.source_text(), OPENING);
    let opening_display = editor.display_text();
    let extra = opening_display.find(" extra").unwrap();
    let one = opening_display.find("one two").unwrap();
    let initial = editor
        .inspect_link(Revision(1), range(one, one + 3))
        .unwrap()
        .unwrap();
    assert_eq!(initial.destination, "/second");
    assert_eq!(initial.title.as_deref(), Some("Second"));
    editor
        .compose(Revision(1), range(extra, extra + 6), "")
        .unwrap();
    let mut provisional = opening_display.clone();
    provisional.replace_range(extra..extra + 6, "");
    let one = provisional.find("one two").unwrap();
    let body = provisional.find("body").unwrap();
    let mut accepted = 0;
    editor
        .replace_many(
            Revision(1),
            &[
                DisplayReplacement {
                    range: range(one, one + 3),
                    inserted: String::new(),
                },
                DisplayReplacement {
                    range: range(body, body + 4),
                    inserted: "BODY".into(),
                },
            ],
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), CHANGED);
    assert_eq!(editor.display_text(), canonical.display_text());
    assert_eq!(
        editor.inspect_link(editor.revision(), range(1, 4)).unwrap(),
        Some(winner)
    );
    editor
        .set_link(editor.revision(), range(1, 4), "/third", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), LINKED);
    assert_eq!(editor.display_text(), final_view.display_text());
    let at = editor.display_text().find("two").unwrap();
    let target = editor
        .inspect_link(editor.revision(), range(at, at + 3))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "/third");
    assert_eq!(target.title.as_deref(), Some("First"));
    for expected in [CHANGED, MARKED, OPENING, ORIGINAL] {
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), expected);
        assert_eq!(
            editor.display_text(),
            EditorSession::open(expected).display_text()
        );
    }
    for expected in [OPENING, MARKED, CHANGED, LINKED] {
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), expected);
    }
    assert_eq!(editor.display_text(), final_view.display_text());
}

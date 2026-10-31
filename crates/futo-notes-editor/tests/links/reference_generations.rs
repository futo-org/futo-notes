//! Current origins include earlier deletion and every nested semantic generation.
use super::*;
use futo_notes_editor::{SourceEdit, SourceOffset, SourceRange};

#[test]
fn normalized_reference_winners_join_the_same_canonical_source_occurrence() {
    const CHANGED: &str = "[É  ID]: /first 'First'\n\n [two][É ID]\n\nBODY\n\nbuffer\n\n[é id]: /second 'Second'\n\ntail";
    let raw_links: Vec<_> = pulldown_cmark::Parser::new_ext(
        CHANGED,
        pulldown_cmark::Options::ENABLE_STRIKETHROUGH | pulldown_cmark::Options::ENABLE_TASKLISTS,
    )
    .filter_map(|event| match event {
        pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link {
            dest_url,
            title,
            id,
            ..
        }) => Some((
            dest_url.into_string(),
            title.into_string(),
            id.into_string(),
        )),
        _ => None,
    })
    .collect();
    assert_eq!(
        raw_links,
        vec![("/first".into(), "First".into(), "É ID".into())],
        "independent canonical parser must establish the normalized winner"
    );
    let tree = markdown::to_mdast(CHANGED, &Default::default()).unwrap();
    let nodes = tree.children().unwrap();
    let markdown::mdast::Node::Definition(first) = &nodes[0] else {
        panic!("expected canonical declaration")
    };
    let usage = nodes[1]
        .children()
        .unwrap()
        .iter()
        .find_map(|node| {
            if let markdown::mdast::Node::LinkReference(usage) = node {
                Some(usage)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(first.identifier, usage.identifier);
    assert_eq!(first.url, "/first");
    assert_eq!(first.title.as_deref(), Some("First"));
    assert_eq!(
        first
            .position
            .as_ref()
            .map(|p| p.start.offset..p.end.offset),
        Some(0..24)
    );
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
}

#[test]
fn earlier_winner_deletion_and_nested_use_transitions_keep_the_current_distant_target() {
    const REMOVED: &str = "[É  ID]: /first 'First'\n\n";
    const CURRENT: &str =
        "head\n\nbuffer\n\n[one][é\tid] [two][É ID]\n\nbody\n\n[é id]: /second 'Second'\n\ntail";
    const MARKED: &str =
        "head\n\nbuffer\n\n [two][É ID]\n\nbody\n\n[é id]: /second 'Second'\n\ntail";
    const LINKED: &str =
        "head\n\nbuffer\n\n [two](</third> \"Second\")\n\nbody\n\n[é id]: /second 'Second'\n\ntail";
    let initial = format!("{REMOVED}{CURRENT}");
    let mut editor = EditorSession::open(&initial);
    let original_display = "head\n\nbuffer\n\none two\n\nbody\n\n[é id]: /second 'Second'\n\ntail";
    assert_eq!(editor.display_text(), original_display);
    let original_link = editor
        .inspect_link(Revision(0), range(14, 17))
        .unwrap()
        .unwrap();
    assert_eq!(original_link.destination, "/first");
    let edit = SourceEdit {
        previous_revision: Revision(0),
        revision: Revision(1),
        range: SourceRange {
            start: SourceOffset(0),
            end: SourceOffset(REMOVED.len()),
        },
        removed: REMOVED.into(),
        inserted: String::new(),
    };
    editor
        .replay_with_accept(&edit, &mut |actual| {
            assert_eq!(actual, &edit);
            Ok(())
        })
        .unwrap();
    assert_eq!(editor.source_text(), CURRENT);
    assert_eq!(
        editor.display_text(),
        "head\n\nbuffer\n\none two\n\nbody\n\ntail"
    );
    let next = editor
        .inspect_link(Revision(1), range(14, 17))
        .unwrap()
        .unwrap();
    assert_eq!(next.destination, "/second");
    assert_eq!(next.title.as_deref(), Some("Second"));
    editor.compose(Revision(1), range(14, 17), "").unwrap();
    let mut accepted = 0;
    editor
        .set_link(Revision(1), range(15, 18), "/third", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), LINKED);
    assert_eq!(
        editor.display_text(),
        "head\n\nbuffer\n\n two\n\nbody\n\n[é id]: /second 'Second'\n\ntail"
    );
    let final_link = editor
        .inspect_link(editor.revision(), range(15, 18))
        .unwrap()
        .unwrap();
    assert_eq!(final_link.destination, "/third");
    assert_eq!(final_link.title.as_deref(), Some("Second"));
    for expected in [MARKED, CURRENT] {
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
    for expected in [MARKED, LINKED] {
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), expected);
    }
    assert_eq!(
        EditorSession::open(LINKED).display_text(),
        editor.display_text()
    );
}

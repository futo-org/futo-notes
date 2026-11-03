use super::*;

#[test]
fn a_full_reference_label_edits_locally_without_rewriting_its_definition_or_title() {
    let original = "see [teh __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let corrected = "see [the __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs\r\n\r\ntail");
    assert_eq!(session.display_text(), view.text);
    let link = session
        .inspect_link(Revision(0), range(5, 6))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(4, 12));
    assert_eq!(link.destination, "https://x.test/a");
    assert_eq!(link.title.as_deref(), Some("Title"));
    view.apply(
        session
            .replace(Revision(0), range(4, 7), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs\r\n\r\ntail");
    assert_eq!(EditorSession::open(corrected).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
}

#[test]
fn ordinary_reference_label_and_body_edits_do_not_copy_or_scan_distant_definitions_or_uses() {
    for growing in ["definitions", "uses", "tail"] {
        let mut work = Vec::new();
        for count in [20, 200] {
            let tail = match growing {
                "definitions" => (0..count)
                    .map(|index| format!("[unused{index}]: https://unused.test/{index}\n\n"))
                    .collect::<String>(),
                "uses" => "[other][focus]\n\n".repeat(count),
                _ => "distant body\n\n".repeat(count),
            };
            let source =
                format!("[teh][focus]\n\nbody\n\n{tail}[focus]: https://x.test \"Title\"\n\nend");
            let corrected =
                format!("[the][focus]\n\nbody\n\n{tail}[focus]: https://x.test \"Title\"\n\nend");
            let mut session = EditorSession::open(&source);
            let label = session
                .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
                .unwrap();
            assert_eq!(session.source_text(), corrected);
            assert!(session.display_text().starts_with("the\n\nbody\n\n"));
            assert!(label.work.link_metadata_items > 0);
            assert!(label.work.link_copied_bytes > 0);
            let body = session
                .replace(Revision(1), range(5, 9), "BODY", &mut |_| Ok(()))
                .unwrap();
            assert!(session.display_text().starts_with("the\n\nBODY\n\n"));
            work.push((label.work, body.work));
        }
        // Exact primitive-ledger contributions; preserve equality of all local
        // work after separating the actual paragraph index traversal.
        let (expected, nodes) = match growing {
            "definitions" => ([(346, 383 + 32), (428, 452 + 32)], [(91, 119), (173, 188)]),
            "uses" => ([(386, 453), (470, 534)], [(99, 125), (183, 206)]),
            _ => ([(346, 373), (428, 442)], [(91, 119), (173, 188)]),
        };
        for (index, (label, body)) in work.iter_mut().enumerate() {
            // Independently observed actual canonical comparison visits at
            // each corpus size; the old exact totals and local budgets stay.
            let references = [(5, 9), (9, 14)][index];
            label.link_metadata_items -= references.0;
            body.link_metadata_items -= references.1;
            // Span sweep visits over the edited row's segments: 17 for the
            // label edit at every size, none for the body edit.
            label.link_metadata_items -= 17;
            assert_eq!(
                (label.link_metadata_items, body.link_metadata_items),
                expected[index]
            );
            // The declaration pass over the reparsed unused definition (its
            // `]:` bound and definition map) costs 32 items for this family
            // only. Preserve the old nonquery body budget below.
            if growing == "definitions" {
                body.link_metadata_items -= 32;
            }
            label.link_metadata_items -= nodes[index].0;
            // The indexed inverse lookup saves exactly one examined item.
            // Restore that query delta before comparing old nonquery work.
            body.link_metadata_items = body.link_metadata_items + 1 - nodes[index].1;
        }
        assert_eq!(work[0], work[1], "local work grew with unrelated {growing}");
    }
}

#[test]
fn shortcut_and_collapsed_label_corrections_retain_definition_identity_with_a_full_tail() {
    for before in ["[teh]", "[teh][]"] {
        let original = format!("{before}\r\n\r\n[teh]: <https://x.test/a> 'Title'\r\n\r\ntail");
        let corrected = "[the][teh]\r\n\r\n[teh]: <https://x.test/a> 'Title'\r\n\r\ntail";
        let mut session = EditorSession::open(&original);
        let mut view = ReferenceView::new("teh\r\n\r\ntail");
        assert_eq!(session.display_text(), view.text);
        view.apply(
            session
                .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), corrected);
        assert_eq!(view.text, "the\r\n\r\ntail");
        let link = session
            .inspect_link(Revision(1), range(0, 3))
            .unwrap()
            .unwrap();
        assert_eq!(link.destination, "https://x.test/a");
        assert_eq!(link.title.as_deref(), Some("Title"));
        assert_eq!(EditorSession::open(corrected).display_text(), view.text);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), corrected);
    }
}

#[test]
fn os_correction_and_nested_composition_keep_a_distant_reference_context() {
    let original = "see [teh __docs__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let corrected = "see [the __docs__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let reconverted = "see [the __資料__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs tail\r\n\r\nmiddle\r\n\r\ntail");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace_os(
                Revision(0),
                range(0, 19),
                "see the docs tail\r\n",
                &[],
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs tail\r\n\r\nmiddle\r\n\r\ntail");
    session
        .compose(Revision(1), range(8, 12), "ドックス")
        .unwrap();
    view.apply(
        session
            .replace(Revision(1), range(8, 20), "資料", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), reconverted);
    assert_eq!(view.text, "see the 資料 tail\r\n\r\nmiddle\r\n\r\ntail");
    let target = session
        .inspect_link(Revision(2), range(8, 14))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "https://x.test/a");
    assert_eq!(target.title.as_deref(), Some("Title"));
    assert_eq!(EditorSession::open(reconverted).display_text(), view.text);
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    // Committing the marked text and the following input retain separate
    // history groups, as in the existing compound-composition contract.
    assert_eq!(session.source_text(), "see [the __ドックス__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail");
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), reconverted);
}

#[test]
fn changing_one_reference_destination_retains_title_and_other_reference_meaning() {
    let original = "[__one__][id] and [two][id]\n\n[id]: <https://old.test> 'A title'\n\nend";
    let changed = "[__one__](<https://new.test> \"A title\") and [two][id]\n\n[id]: <https://old.test> 'A title'\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("one and two\n\nend");
    session.select(Revision(0), range(1, 2)).unwrap();
    view.apply(
        session
            .set_link(
                Revision(0),
                range(1, 2),
                "https://new.test",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, "one and two\n\nend");
    assert_eq!(session.selection(), range(1, 2));
    let first = session
        .inspect_link(Revision(1), range(0, 3))
        .unwrap()
        .unwrap();
    assert_eq!(first.destination, "https://new.test");
    assert_eq!(first.title.as_deref(), Some("A title"));
    let second = session
        .inspect_link(Revision(1), range(8, 11))
        .unwrap()
        .unwrap();
    assert_eq!(second.destination, "https://old.test");
    assert_eq!(second.title.as_deref(), Some("A title"));
    assert_eq!(EditorSession::open(changed).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
}

#[test]
fn unlinking_the_last_reference_reveals_its_retained_unused_definition_atomically() {
    let original = "[one][id]\n\nmiddle\n\n[id]: <https://x.test> 'T'\n\nend";
    let unlinked = "one\n\nmiddle\n\n[id]: <https://x.test> 'T'\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("one\n\nmiddle\n\nend");
    session.select(Revision(0), range(1, 2)).unwrap();
    view.apply(
        session
            .set_link(Revision(0), range(1, 2), "", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), unlinked);
    assert_eq!(view.text, unlinked);
    assert_eq!(session.selection(), range(1, 2));
    assert!(session
        .inspect_link(Revision(1), range(0, 3))
        .unwrap()
        .is_none());
    assert_eq!(EditorSession::open(unlinked).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "one\n\nmiddle\n\nend");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), unlinked);
    assert_eq!(view.text, unlinked);
}

#[test]
fn last_use_unlink_maps_selection_past_a_definition_revealed_before_the_label() {
    let original = "[id]: <https://x.test> 'T'\n\nmiddle\n\n[one][id] end";
    let unlinked = "[id]: <https://x.test> 'T'\n\nmiddle\n\none end";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("middle\n\none end");
    assert_eq!(session.display_text(), view.text);
    session.select(Revision(0), range(9, 10)).unwrap();
    view.apply(
        session
            .set_link(Revision(0), range(9, 10), "", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), unlinked);
    assert_eq!(view.text, unlinked);
    assert_eq!(session.selection(), range(37, 38));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "middle\n\none end");
    assert_eq!(session.selection(), range(9, 10));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), unlinked);
    assert_eq!(session.selection(), range(37, 38));
}

#[test]
fn replaying_winner_removal_uses_the_next_distant_definition_and_updates_visibility() {
    use futo_notes_editor::{SourceEdit, SourceOffset, SourceRange};
    let original = "[id]: /first\n\nmiddle\n\n[x][id]\n\n[id]: /second\n\nend";
    let recovered = "middle\n\n[x][id]\n\n[id]: /second\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("middle\n\nx\n\n[id]: /second\n\nend");
    assert_eq!(session.display_text(), view.text);
    assert_eq!(
        session
            .inspect_link(Revision(0), range(8, 9))
            .unwrap()
            .unwrap()
            .destination,
        "/first"
    );
    let record = SourceEdit {
        previous_revision: Revision(0),
        revision: Revision(1),
        range: SourceRange {
            start: SourceOffset(0),
            end: SourceOffset(14),
        },
        removed: "[id]: /first\n\n".into(),
        inserted: String::new(),
    };
    let mut accepted = 0;
    view.apply(
        session
            .replay_with_accept(&record, &mut |actual| {
                assert_eq!(actual, &record);
                accepted += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), recovered);
    assert_eq!(view.text, "middle\n\nx\n\nend");
    assert_eq!(
        session
            .inspect_link(Revision(1), range(8, 9))
            .unwrap()
            .unwrap()
            .destination,
        "/second"
    );
    assert_eq!(EditorSession::open(recovered).display_text(), view.text);
}

#[test]
fn a_later_duplicate_inside_the_staged_window_never_shadows_the_global_first_definition() {
    let original = "[id]: /first 'First'\n\nmiddle\n\n[teh][ID]\n\n[id]: /second 'Later'\n\nend";
    let corrected = "[id]: /first 'First'\n\nmiddle\n\n[the][ID]\n\n[id]: /second 'Later'\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("middle\n\nteh\n\n[id]: /second 'Later'\n\nend");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace_os(Revision(0), range(8, 11), "the", &[], &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "middle\n\nthe\n\n[id]: /second 'Later'\n\nend");
    let target = session
        .inspect_link(Revision(1), range(8, 11))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "/first");
    assert_eq!(target.title.as_deref(), Some("First"));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
}

#[test]
fn a_remaining_reference_image_keeps_the_definition_used_after_link_unlink() {
    let original = "[one][id] and ![alt][id]\n\nmiddle\n\n[id]: /image 'T'\n\nend";
    let unlinked = "one and ![alt][id]\n\nmiddle\n\n[id]: /image 'T'\n\nend";
    let mut session = EditorSession::open(original);
    // Image rendering is a separate feature; its existing literal source body
    // still counts as a canonical reference use for definition visibility.
    let mut view = ReferenceView::new("one and ![alt][id]\n\nmiddle\n\nend");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .set_link(Revision(0), range(0, 3), "", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), unlinked);
    assert_eq!(view.text, "one and ![alt][id]\n\nmiddle\n\nend");
    assert_eq!(EditorSession::open(unlinked).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), unlinked);
}

#[test]
fn a_label_correction_preserves_the_hidden_winning_definition_in_its_own_row() {
    let original = "[id]: /target 'T'\n[teh][id] tail";
    let corrected = "[id]: /target 'T'\n[the][id] tail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("teh tail");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "the tail");
    let target = session
        .inspect_link(Revision(1), range(0, 3))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "/target");
    assert_eq!(target.title.as_deref(), Some("T"));
    assert_eq!(EditorSession::open(corrected).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
}

#[test]
fn compound_last_use_removal_retains_the_later_body_target_across_definition_visibility() {
    use futo_notes_editor::DisplayReplacement;
    let original = "[one][id]\n\nmiddle\n\n[id]: /target 'T'\n\nbody";
    let changed = "\n\nmiddle\n\n[id]: /target 'T'\n\nBODY";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("one\n\nmiddle\n\nbody");
    assert_eq!(session.display_text(), view.text);
    let mut accepted = 0;
    view.apply(
        session
            .replace_many(
                Revision(0),
                &[
                    DisplayReplacement {
                        range: range(0, 3),
                        inserted: String::new(),
                    },
                    DisplayReplacement {
                        range: range(13, 17),
                        inserted: "BODY".into(),
                    },
                ],
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(33, 33));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "one\n\nmiddle\n\nbody");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(33, 33));
    assert_eq!(EditorSession::open(changed).display_text(), view.text);
}

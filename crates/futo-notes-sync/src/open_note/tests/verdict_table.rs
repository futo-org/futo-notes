use super::*;

/// The disposition table, exhaustively. Every row is one reachable
/// combination of (reported rename, disk state, dirtiness, focus);
/// together they cover every arm of the classifier.
#[test]
fn every_reachable_fact_combination_has_one_verdict() {
    let cases: Vec<(&str, OpenNoteFacts, OpenNoteDisposition)> = vec![
        ("nothing moved", facts(), OpenNoteDisposition::Leave),
        (
            "a reported rename outranks a clean adopt",
            OpenNoteFacts {
                disk: Some("peer".to_owned()),
                renamed_to: Some("Note (2)".to_owned()),
                ..facts()
            },
            OpenNoteDisposition::FollowRename {
                to_id: "Note (2)".to_owned(),
            },
        ),
        (
            "a reported rename outranks a peer delete",
            OpenNoteFacts {
                disk: None,
                renamed_to: Some("Note (2)".to_owned()),
                ..facts()
            },
            OpenNoteDisposition::FollowRename {
                to_id: "Note (2)".to_owned(),
            },
        ),
        (
            "a reported rename outranks a dirty draft",
            OpenNoteFacts {
                draft: "mine".to_owned(),
                renamed_to: Some("Note (2)".to_owned()),
                ..facts()
            },
            OpenNoteDisposition::FollowRename {
                to_id: "Note (2)".to_owned(),
            },
        ),
        (
            "peer deleted a clean note",
            OpenNoteFacts {
                disk: None,
                ..facts()
            },
            OpenNoteDisposition::Close,
        ),
        (
            "peer deleted a note with unsaved work",
            OpenNoteFacts {
                disk: None,
                draft: "mine".to_owned(),
                ..facts()
            },
            keep_draft("base", KeepDraftReason::PeerDeleted),
        ),
        (
            // Typing that ended back at the base leaves nothing to
            // preserve, so the delete still stands fleet-wide.
            "peer deleted a note edited back to its base during the cycle",
            OpenNoteFacts {
                disk: None,
                edited_during_cycle: true,
                ..facts()
            },
            OpenNoteDisposition::Close,
        ),
        (
            "clean editor, peer edit, unfocused",
            OpenNoteFacts {
                disk: Some("peer".to_owned()),
                ..facts()
            },
            OpenNoteDisposition::Adopt {
                content: "peer".to_owned(),
            },
        ),
        (
            "clean editor, peer edit, focused — every host waits for blur",
            OpenNoteFacts {
                disk: Some("peer".to_owned()),
                editor_focused: true,
                ..facts()
            },
            OpenNoteDisposition::DeferAdopt,
        ),
        (
            "dirty draft, disk unchanged",
            OpenNoteFacts {
                draft: "mine".to_owned(),
                ..facts()
            },
            OpenNoteDisposition::Leave,
        ),
        (
            "dirty draft, peer edit",
            OpenNoteFacts {
                draft: "mine".to_owned(),
                disk: Some("peer".to_owned()),
                ..facts()
            },
            keep_draft("base", KeepDraftReason::Diverged),
        ),
        (
            "dirty draft, peer edit, focused",
            OpenNoteFacts {
                draft: "mine".to_owned(),
                disk: Some("peer".to_owned()),
                editor_focused: true,
                ..facts()
            },
            keep_draft("base", KeepDraftReason::Diverged),
        ),
        (
            "draft and disk converged on the same text",
            OpenNoteFacts {
                draft: "same".to_owned(),
                disk: Some("same".to_owned()),
                ..facts()
            },
            keep_draft("same", KeepDraftReason::Converged),
        ),
        (
            "edited during the cycle, peer edit — the draft is protected",
            OpenNoteFacts {
                disk: Some("peer".to_owned()),
                edited_during_cycle: true,
                ..facts()
            },
            keep_draft("base", KeepDraftReason::Diverged),
        ),
    ];

    for (name, given, expected) in cases {
        assert_eq!(classify_open_note(given), expected, "case: {name}");
    }
}

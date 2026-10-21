use super::*;

/// A reported relocation is followed whatever else is true. This is what
/// makes engine-side rename reporting load-bearing: every relocation the
/// engine performs reports rename intent, and an UNREPORTED one is the only
/// way an open editor can be stranded on an id whose content moved. The
/// tombstone park used to be unreported, so a peer delete of a note whose
/// draft had just reached disk classified as `Close` (no disk, draft ==
/// base) and threw the buffer away.
#[test]
fn a_reported_rename_is_always_followed() {
    let to_id = "Note (conflict 019fdd01)";
    for disk in [None, Some("peer"), Some("base"), Some("mine")] {
        for draft in ["base", "mine"] {
            for editor_focused in [false, true] {
                for edited_during_cycle in [false, true] {
                    let disposition = classify_open_note(OpenNoteFacts {
                        draft: draft.to_owned(),
                        disk: disk.map(str::to_owned),
                        renamed_to: Some(to_id.to_owned()),
                        editor_focused,
                        edited_during_cycle,
                        ..facts()
                    });
                    assert_eq!(
                        disposition,
                        OpenNoteDisposition::FollowRename {
                            to_id: to_id.to_owned()
                        },
                        "reported rename not followed: disk={disk:?} draft={draft} \
                             focused={editor_focused} edited_during_cycle={edited_during_cycle}"
                    );
                }
            }
        }
    }
}

/// The classifier never adopts over unsaved work, whatever else is true.
/// This is the persist-or-park promise at the open-note seam: the draft is
/// written, recreated, or parked — never replaced.
#[test]
fn a_dirty_draft_is_never_replaced() {
    for disk in [None, Some("peer"), Some("base"), Some("mine")] {
        for focused in [false, true] {
            for edited_during_cycle in [false, true] {
                let disposition = classify_open_note(OpenNoteFacts {
                    draft: "mine".to_owned(),
                    disk: disk.map(str::to_owned),
                    editor_focused: focused,
                    edited_during_cycle,
                    ..facts()
                });
                assert!(
                    !matches!(
                        disposition,
                        OpenNoteDisposition::Adopt { .. } | OpenNoteDisposition::Close
                    ),
                    "dirty draft was discarded: disk={disk:?} focused={focused} \
                         edited_during_cycle={edited_during_cycle} -> {disposition:?}"
                );
            }
        }
    }
}

/// A converged draft rebases onto disk, because there the baseline was
/// merely stale: disk already holds the draft, and leaving the baseline
/// describing older content is what let a later save clobber a peer's
/// merged-in edit (F2).
#[test]
fn a_converged_draft_rebases_onto_what_is_actually_on_disk() {
    let disposition = classify_open_note(OpenNoteFacts {
        draft: "same".to_owned(),
        disk: Some("same".to_owned()),
        ..facts()
    });
    assert_eq!(disposition, keep_draft("same", KeepDraftReason::Converged));
}

/// A diverged draft does the OPPOSITE, and issue #89 was the cost of
/// reading the two as one rule: the baseline it keeps is the one it had.
/// `flush_draft` parks exactly when `current != base`, so the pre-pull base
/// is what makes the next flush park the draft as a conflict copy and leave
/// the peer's bytes alone. Handing back `disk` put that flush on its
/// `current == base` fast-forward arm and destroyed the peer's edit.
#[test]
fn a_diverged_draft_keeps_the_baseline_that_makes_the_next_flush_park() {
    for edited_during_cycle in [false, true] {
        for editor_focused in [false, true] {
            let disposition = classify_open_note(OpenNoteFacts {
                draft: "mine".to_owned(),
                disk: Some("peer".to_owned()),
                editor_focused,
                edited_during_cycle,
                ..facts()
            });
            assert_eq!(
                disposition,
                keep_draft("base", KeepDraftReason::Diverged),
                "focused={editor_focused} edited_during_cycle={edited_during_cycle}"
            );
        }
    }
}

/// Every combination of the facts, not just the tabulated rows: for any
/// base/draft/disk over a small alphabet, and every focus / edited-during-
/// cycle flag, the two promises the classifier owns hold.
///
/// 1. Unsaved work is never replaced (persist-or-park at the open-note
///    seam). A verdict may keep, park or recreate a draft; nothing may
///    overwrite the buffer or close the session while the buffer holds text
///    the base does not.
/// 2. A kept draft's baseline is always a value the editor ACTUALLY holds —
///    disk when the draft already equals disk (`Converged`, where a stale
///    baseline would leave the session falsely dirty and was what let a
///    later save clobber a peer's merged-in edit, F2), and otherwise the
///    base it opened or last saved. Every shell assigns this straight to its
///    `savedContent`, which is also the expected-previous its next
///    `flush_draft` is conditioned on, so the two are the same value by
///    construction: claiming the editor last saved the peer's bytes is what
///    turned the park into a fast-forward and destroyed them (#89).
///
/// The tabulated test above says what each row answers; this says what no
/// row is allowed to answer, which is what survives someone adding a case.
#[test]
fn no_reachable_fact_combination_can_discard_unsaved_work() {
    let alphabet = ["base", "peer", "mine", ""];
    for base in alphabet {
        for draft in alphabet {
            for disk in [None, Some("base"), Some("peer"), Some("mine"), Some("")] {
                for editor_focused in [false, true] {
                    for edited_during_cycle in [false, true] {
                        let given = OpenNoteFacts {
                            base: base.to_owned(),
                            draft: draft.to_owned(),
                            disk: disk.map(str::to_owned),
                            renamed_to: None,
                            editor_focused,
                            edited_during_cycle,
                        };
                        let disposition = classify_open_note(given.clone());

                        if draft != base {
                            assert!(
                                !matches!(
                                    disposition,
                                    OpenNoteDisposition::Adopt { .. } | OpenNoteDisposition::Close
                                ),
                                "unsaved work was discarded: {given:?} -> {disposition:?}"
                            );
                        }

                        if let (
                            OpenNoteDisposition::KeepDraft {
                                base: kept, reason, ..
                            },
                            Some(disk),
                        ) = (&disposition, disk)
                        {
                            let expected = match reason {
                                KeepDraftReason::Converged => disk,
                                KeepDraftReason::Diverged | KeepDraftReason::PeerDeleted => base,
                            };
                            assert_eq!(
                                kept, expected,
                                "a kept draft's baseline must be bytes the editor holds, \
                                     which its next flush can be conditioned on: {given:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

/// The blur settle is a SEQUENCE of two verdicts, and the second one is
/// where a lost keystroke would show up: the shell remembers `DeferAdopt`,
/// the user keeps typing, and the shell re-gathers on blur. Whatever was
/// typed in between must survive that second pass — a deferral exists so
/// the draft outlives it, never so a stale adopt can land later.
///
/// Re-gathering is what makes this true: a shell that settled a deferral
/// by applying the content it remembered at defer time would replace the
/// buffer here, and this asserts over every draft the user could have
/// typed rather than one example.
#[test]
fn settling_a_deferred_adopt_never_discards_work_typed_since_the_deferral() {
    let alphabet = ["base", "peer", "typed", ""];
    for base in alphabet {
        for disk_at_defer in alphabet {
            let deferral = classify_open_note(OpenNoteFacts {
                base: base.to_owned(),
                draft: base.to_owned(),
                disk: Some(disk_at_defer.to_owned()),
                renamed_to: None,
                editor_focused: true,
                edited_during_cycle: false,
            });
            if deferral != OpenNoteDisposition::DeferAdopt {
                continue;
            }

            for typed in alphabet {
                if typed == base {
                    continue;
                }
                for disk_at_blur in [disk_at_defer, "later peer"] {
                    // `edited_during_cycle` is false in the case that
                    // matters most: a shell snapshots its edit epoch when
                    // the settle pass STARTS, so typing done between the
                    // deferral and the blur is invisible to that flag and
                    // only `draft != base` can protect it.
                    for edited_during_cycle in [false, true] {
                        let settled = classify_open_note(OpenNoteFacts {
                            base: base.to_owned(),
                            draft: typed.to_owned(),
                            disk: Some(disk_at_blur.to_owned()),
                            renamed_to: None,
                            editor_focused: false,
                            edited_during_cycle,
                        });
                        assert!(
                            !matches!(settled, OpenNoteDisposition::Adopt { .. }),
                            "settling the deferral adopted over work typed since it: \
                                 base={base:?} typed={typed:?} disk={disk_at_blur:?} \
                                 edited_during_cycle={edited_during_cycle} -> {settled:?}"
                        );
                    }
                }
            }
        }
    }
}

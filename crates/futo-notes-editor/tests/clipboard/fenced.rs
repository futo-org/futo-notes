//! Fenced clipboard target ownership, through the public session.
use super::{paste, range, EditorSession, Revision};

#[test]
fn block_paste_in_an_empty_fence_stays_literal() {
    for (source, expected) in [
        ("```\n\n```", "```\n# h\n```"),
        ("```\n\n```\n", "```\n# h\n```\n"),
        ("```\n```", "```\n# h\n```"),
        ("```", "```\n# h"),
        ("> ```\n> \n> ```", "> ```\n> # h\n> ```"),
        ("- ```\n  \n  ```", "- ```\n  # h\n  ```"),
    ] {
        let pasted = paste(source, range(0, 0), "# h", Some(3));
        assert_eq!(pasted.source_text(), expected);
        assert_eq!(pasted.display_text(), "# h");
        assert!(pasted.toolbar_state().code);
    }
}

#[test]
fn block_paste_at_saved_code_end_stays_literal() {
    let pasted = paste("```\nx\n```\n", range(1, 1), "# h", Some(4));
    assert_eq!(pasted.source_text(), "```\nx# h\n```\n");
    assert_eq!(pasted.display_text(), "x# h");
    assert!(pasted.toolbar_state().code);
}

#[test]
fn block_paste_after_genuine_code_separator_remains_prose() {
    let pasted = paste("```\nx\n```\n\n", range(3, 3), "# h", Some(4));
    assert_eq!(pasted.source_text(), "```\nx\n```\n\n# h");
    assert_eq!(pasted.display_text(), "x\n\nh");
    assert!(!pasted.toolbar_state().code);
    assert_eq!(pasted.toolbar_state().heading, Some(1));
}

#[test]
fn empty_fence_plain_paste_and_nonempty_fence_block_paste_controls() {
    for (source, selected, text, expected) in [
        ("```\n\n```", range(0, 0), "a\nb", "```\na\nb\n```"),
        ("```\nx\n```\n", range(0, 1), "# h", "```\n# h\n```\n"),
    ] {
        let pasted = paste(source, selected, text, Some(3));
        assert_eq!(pasted.source_text(), expected);
        assert_eq!(pasted.display_text(), text);
        assert!(pasted.toolbar_state().code);
    }
}

#[test]
fn empty_code_paste_keeps_block_payloads_opaque() {
    for (text, expected) in [
        ("- item", "```\n- item\n```"),
        ("> quote", "```\n> quote\n```"),
        ("a\n\nb", "```\na\n\nb\n```"),
        ("|h|t|\n|-|-|", "```\n|h|t|\n|-|-|\n```"),
        ("a\n```\nb", "````\na\n```\nb\n````"),
    ] {
        let pasted = paste("```\n\n```", range(0, 0), text, Some(text.len()));
        assert_eq!(pasted.source_text(), expected);
        assert_eq!(pasted.display_text(), text);
        assert!(pasted.toolbar_state().code);
    }
}
#[test]
fn empty_fences_beside_real_prose_do_not_take_its_paste() {
    for (source, at, caret, expected, shown) in [
        (
            "```\n\n```\n\nplain",
            2,
            3,
            "```\n\n```\n\n# h\nplain",
            "\n\nh\nplain",
        ),
        (
            "```\n\n```\n\nplain",
            7,
            9,
            "```\n\n```\n\nplain\n# h",
            "\n\nplain\nh",
        ),
        (
            "plain\n\n```\n\n```",
            0,
            1,
            "# h\nplain\n\n```\n\n```",
            "h\nplain\n\n",
        ),
        (
            "plain\n\n```\n\n```",
            5,
            7,
            "plain\n# h\n\n```\n\n```",
            "plain\nh\n\n",
        ),
    ] {
        let pasted = paste(source, range(at, at), "# h", Some(caret));
        assert_eq!(pasted.source_text(), expected);
        assert_eq!(pasted.display_text(), shown);
        assert!(!pasted.toolbar_state().code);
        assert_eq!(pasted.toolbar_state().heading, Some(1));
    }
}

#[test]
fn indented_code_keeps_its_existing_literal_paste_path() {
    let pasted = paste("    x\n", range(1, 1), "# h", Some(4));
    assert_eq!(pasted.source_text(), "    x# h\n");
    assert_eq!(pasted.display_text(), "x# h\n");
    assert!(pasted.toolbar_state().code);
}

#[test]
fn block_paste_retires_an_empty_frame_selected_with_prose() {
    for (source, selected) in [
        ("```\n\n```\n\nplain\n", range(0, 8)),
        ("```\n\n```\n\nplain", range(0, 7)),
    ] {
        let pasted = paste(source, selected, "# h", None);
        assert_eq!(pasted.source_text(), "# h");
        assert_eq!(pasted.display_text(), "h");
        assert_eq!(pasted.selection(), range(1, 1));
        assert!(!pasted.toolbar_state().code);
        assert_eq!(pasted.toolbar_state().heading, Some(1));
    }
}

#[test]
fn block_paste_retires_a_nonempty_frame_selected_with_prose() {
    let pasted = paste("```\nx\n```\n\nplain\n", range(0, 9), "# h", None);
    assert_eq!(pasted.source_text(), "# h");
    assert_eq!(pasted.display_text(), "h");
    assert_eq!(pasted.selection(), range(1, 1));
    assert!(!pasted.toolbar_state().code);
    assert_eq!(pasted.toolbar_state().heading, Some(1));
}

#[test]
fn block_paste_retires_a_complete_selected_frame_after_prose() {
    for (source, selected) in [
        ("plain\n\n```\n\n```", range(0, 7)),
        ("plain\n\n```\nx\n```", range(0, 8)),
    ] {
        let pasted = paste(source, selected, "# h", None);
        assert_eq!(pasted.source_text(), "# h");
        assert_eq!(pasted.display_text(), "h");
        assert_eq!(pasted.selection(), range(1, 1));
    }
}

#[test]
fn block_paste_retires_separate_complete_selected_frames() {
    let source = "```\nx\n```\n\nmiddle\n\n```\ny\n```";
    let pasted = paste(source, range(0, 12), "# h", None);
    assert_eq!(pasted.source_text(), "# h");
    assert_eq!(pasted.display_text(), "h");
    assert_eq!(pasted.selection(), range(1, 1));
}

#[test]
fn selected_frame_paste_keeps_unselected_prose_exact() {
    for (selected, expected, shown, caret) in [
        (range(8, 16), "before\n\n# h", "before\n\nh", 9),
        (range(0, 9), "# h\n\nafter", "h\n\nafter", 1),
    ] {
        let pasted = paste("before\n\n```\nx\n```\n\nafter", selected, "# h", None);
        assert_eq!(pasted.source_text(), expected);
        assert_eq!(pasted.display_text(), shown);
        assert_eq!(pasted.selection(), range(caret, caret));
    }
}

#[test]
fn body_only_paste_keeps_its_frame_and_unselected_neighbor_exact() {
    for (selected, expected) in [
        (range(0, 1), "```\n# hbc\n```\n\n~~~rs\nneighbour\n~~~"),
        (range(0, 3), "```\n# h\n```\n\n~~~rs\nneighbour\n~~~"),
    ] {
        let pasted = paste(
            "```\nabc\n```\n\n~~~rs\nneighbour\n~~~",
            selected,
            "# h",
            Some(3),
        );
        assert_eq!(pasted.source_text(), expected);
        assert!(pasted.toolbar_state().code);
    }
}

#[test]
fn selected_frame_paste_keeps_the_opening_carets_line_ending() {
    let pasted = paste(
        "```\r\n\r\n```\r\n\r\nplain\r\n",
        range(0, 11),
        "# h\nbody",
        Some(7),
    );
    assert_eq!(pasted.source_text(), "# h\r\nbody");
    assert_eq!(pasted.display_text(), "h\r\nbody");
}

#[test]
fn selected_frame_paste_drops_only_one_copied_trailing_ending() {
    let pasted = paste("```\n\n```\n\nplain\n", range(0, 8), "# h\n\n", Some(2));
    assert_eq!(pasted.source_text(), "# h\n");
    assert_eq!(pasted.display_text(), "h\n");
}

#[test]
fn selected_frame_paste_keeps_unicode_boundaries_and_payload() {
    let source = "```\n🧑‍💻\n```\n\nplain\n";
    let mut session = EditorSession::open(source);
    session.select(Revision(0), range(0, 19)).unwrap();
    for invalid in [range(1, 19), range(0, 999), range(19, 0)] {
        let mut accepted = 0;
        assert!(session
            .paste_markdown(Revision(0), invalid, "# h", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(accepted, 0);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.selection(), range(0, 19));
        assert_eq!(session.revision(), Revision(0));
    }
    let pasted = paste(source, range(0, 19), "# 猫\nbody", Some(8));
    assert_eq!(pasted.source_text(), "# 猫\nbody");
    assert_eq!(pasted.display_text(), "猫\nbody");
}

#[test]
fn rejected_selected_frame_paste_retains_source_selection_and_history() {
    let source = "```\n\n```\n\nplain\n";
    let mut session = EditorSession::open(source);
    let selected = range(0, 8);
    session.select(Revision(0), selected).unwrap();
    let mut accepted = 0;
    assert!(session
        .paste_markdown(Revision(0), selected, "# h", &mut |_| {
            accepted += 1;
            Err("rejected append".into())
        })
        .is_err());
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.selection(), selected);
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    assert!(session
        .redo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn selected_frame_paste_retires_partitioned_fences_with_exact_endings() {
    for eol in ["\n", "\r\n"] {
        let body = format!("x{eol}").repeat(2_000);
        let source = format!("```{eol}{body}```{eol}{eol}plain{eol}");
        let shown = format!("{body}{eol}plain{eol}");
        assert_eq!(EditorSession::open(&source).display_text(), shown);
        let pasted = paste(&source, range(0, shown.len()), "# h", Some(1));
        assert_eq!(pasted.source_text(), "# h");
        assert_eq!(pasted.display_text(), "h");
    }
}

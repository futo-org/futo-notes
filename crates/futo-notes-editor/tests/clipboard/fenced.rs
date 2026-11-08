//! Fenced clipboard target ownership, through the public session.
use super::{paste, range};

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

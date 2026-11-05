use super::*;

/// Block commands write the caret line's line ending, as Enter does: in a
/// CRLF note no command leaves a bare LF, and Undo restores the exact bytes.
#[test]
fn block_commands_write_the_caret_lines_crlf() {
    let bare = |s: &str| {
        let b = s.as_bytes();
        (0..b.len()).any(|i| b[i] == b'\n' && (i == 0 || b[i - 1] != b'\r'))
    };
    let commands = [
        BlockCommand::Heading(0),
        BlockCommand::Heading(2),
        BlockCommand::ToggleHeading(1),
        BlockCommand::Quote,
        BlockCommand::Indent,
        BlockCommand::Outdent,
        BlockCommand::Divider,
        BlockCommand::ToggleTask,
        BlockCommand::BulletList,
        BlockCommand::OrderedList,
        BlockCommand::TaskList,
        BlockCommand::CodeBlock,
        BlockCommand::WrapCodeBlock,
    ];
    let mut failures = Vec::new();
    for opening in [
        "ab\r\ncd\r\n",
        "__ab__\r\nend\r\n",
        "para\r\n\r\n",
        "para\r\nnext\r\n",
        "- a\r\n- b\r\n",
        "1. a\r\n2. b\r\n\r\ntail\r\n",
        "- [ ] a\r\n- [x] b\r\n",
        "> q\r\n> r\r\n",
        "# h\r\nbody\r\n",
        "```\r\ncode\r\n```\r\n",
        "a\r\n\r\n- b\r\n",
    ] {
        let display = EditorSession::open(opening).display_text();
        let mut ranges = vec![(0, 0), (1, 1), (0, display.len())];
        ranges.extend(
            display
                .match_indices("\r\n")
                .map(|(at, _)| (at + 2, at + 2)),
        );
        ranges.extend(display.match_indices("\r\n").map(|(at, _)| (at, at)));
        for (a, z) in ranges {
            if z > display.len() || !display.is_char_boundary(a) || !display.is_char_boundary(z) {
                continue;
            }
            for command in commands {
                let mut s = EditorSession::open(opening);
                let mut v = ReferenceView::new(&display);
                let Ok(Some(change)) =
                    s.block_command(s.revision(), range(a, z), command, &mut |_| Ok(()))
                else {
                    continue;
                };
                if change.revision == change.previous_revision {
                    continue;
                }
                v.apply(change);
                let source = s.source_text();
                if bare(&source) {
                    failures.push(format!("{opening:?} {a}..{z} {command:?}: {source:?}"));
                    continue;
                }
                assert_eq!(v.text, s.display_text(), "{opening:?} {a}..{z} {command:?}");
                v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
                assert_eq!(s.source_text(), opening, "{opening:?} {a}..{z} {command:?}");
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

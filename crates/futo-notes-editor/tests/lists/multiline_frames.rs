use super::*;

// The ten shipping oracle101 observations share these seven original sources.
// Outdent retains a parallel empty paragraph, Backspace merges it, and full
// Text retires all list ancestry. Serializer blank normalization is not gold.
#[test]
fn literal_multiline_frame_plans_reopen_with_their_public_body_owners() {
    for (raw, shown, depth, quotes, number) in [
        ("- > b\n  > c", "b\nc", Some(1), 1, None),
        ("- > b\n  c", "b\nc", Some(1), 1, None),
        ("> - > b\n>   > c", "b\nc", Some(1), 2, None),
        ("1000.\t> b\n        > c", "b\nc", Some(1), 1, Some(1000)),
        ("- - > b\n    > c", "b\nc", Some(2), 1, None),
        ("- > - b\n  >   c", "b\nc", Some(2), 1, None),
        ("- \n  b\n  c", "\nb\nc", Some(1), 0, None),
        ("> - \n>   b\n>   c", "\nb\nc", Some(1), 1, None),
        (
            "1000.\t\n        b\n        c",
            "\nb\nc",
            Some(1),
            0,
            Some(1000),
        ),
        ("- b\n  c", "b\nc", Some(1), 0, None),
        ("> - b\n>   c", "b\nc", Some(1), 1, None),
        ("\n> b\n> c", "\nb\nc", None, 1, None),
        ("- \n\n> b\n> c", "\n\nb\nc", None, 1, None),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown, "{raw:?}");
        for body in ['b', 'c'] {
            let at = shown.find(body).unwrap();
            let projected = s.project(s.revision(), range(at, at + 1)).unwrap();
            assert!(
                projected.blocks.iter().any(|block| !block.code
                    && block.heading == 0
                    && block.quote_depth == quotes
                    && block.list.as_ref().map(|list| (list.depth, list.number))
                        == depth.map(|depth| (depth, number))),
                "{raw:?} at {body}"
            );
        }
    }
}

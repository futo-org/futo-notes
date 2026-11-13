//! Wikilink roles: targets, labels and resolution, and edits at a link's
//! boundaries.
use super::*;

#[test]
fn wikilinks_resolve_against_the_delivered_note_ids() {
    let roadmap = || {
        role(
            "[[Roadmap]]",
            "Roadmap",
            "Roadmap",
            Some("Projects/Roadmap"),
        )
    };
    for (source, expected) in [
        (
            "see [[Projects/Roadmap]] ok",
            vec![role(
                "[[Projects/Roadmap]]",
                "Projects/Roadmap",
                "Roadmap",
                Some("Projects/Roadmap"),
            )],
        ),
        // A bare leaf resolves to its one owner and shows its unique suffix.
        ("[[Roadmap]]", vec![roadmap()]),
        // Ambiguous and absent targets are unresolved and show the target.
        (
            "[[Notes]] [[Nope]]",
            vec![
                role("[[Notes]]", "Notes", "Notes", None),
                role("[[Nope]]", "Nope", "Nope", None),
            ],
        ),
        (
            "[[Work/Notes]]",
            vec![role(
                "[[Work/Notes]]",
                "Work/Notes",
                "Work/Notes",
                Some("Work/Notes"),
            )],
        ),
        // A leading `!` stays text; `|` and an inner `[[` are target.
        ("![[a|b]]", vec![role("[[a|b]]", "a|b", "a|b", Some("a|b"))]),
        (
            "[[x[[Roadmap]]",
            vec![role("[[x[[Roadmap]]", "x[[Roadmap", "x[[Roadmap", None)],
        ),
        (
            "[[Nope]]] [[]] [[a\nb]]",
            vec![role("[[Nope]]", "Nope", "Nope", None)],
        ),
        // A wikilink's text is its target, not Markdown.
        (
            "[[*Nope*]]",
            vec![role("[[*Nope*]]", "*Nope*", "*Nope*", None)],
        ),
        // Read on every line with inline marks, before link syntax.
        ("# [[Roadmap]]", vec![roadmap()]),
        ("- [ ] [[Roadmap]]", vec![roadmap()]),
        ("> [[Roadmap]]", vec![roadmap()]),
        ("    [[Roadmap]]", vec![roadmap()]),
        ("| [[Roadmap]] |\n|---|", vec![roadmap()]),
        ("[[Roadmap]](https://x.test)", vec![roadmap()]),
        ("`[[x]]` [[Roadmap]]", vec![roadmap()]),
        // Code, an escaped bracket and front matter hold none.
        ("`[[Roadmap]]`", vec![]),
        ("```\n[[Roadmap]]\n```", vec![]),
        ("\\[[Roadmap]]", vec![]),
        ("---\ntitle: [[Roadmap]]\n---\n", vec![]),
    ] {
        let engine = with_ids(source, LINKED);
        assert_eq!(roles(&engine), expected, "{source:?}");
        assert_eq!(engine.source_text(), source);
    }
    // Before any note ids arrive every link is unresolved.
    assert_eq!(
        roles(&Engine::open("[[Roadmap]]")),
        vec![role("[[Roadmap]]", "Roadmap", "Roadmap", None)]
    );
}

#[test]
fn edits_at_link_boundaries_save_exact_bytes_and_read_again() {
    // (source, display range, inserted, saved source, roles after)
    let roadmap = || {
        vec![role(
            "[[Roadmap]]",
            "Roadmap",
            "Roadmap",
            Some("Projects/Roadmap"),
        )]
    };
    type Edit = (
        &'static str,
        (usize, usize),
        &'static str,
        &'static str,
        Vec<Role>,
    );
    let cases: Vec<Edit> = vec![
        ("a [[Roadmap", (11, 11), "]]", "a [[Roadmap]]", roadmap()),
        ("a [[Roadmap]] b", (12, 13), "", "a [[Roadmap] b", vec![]),
        ("a [[Roadmap]] b", (2, 3), "", "a [Roadmap]] b", vec![]),
        (
            "[[Notes]]",
            (2, 2),
            "Work/",
            "[[Work/Notes]]",
            vec![role(
                "[[Work/Notes]]",
                "Work/Notes",
                "Work/Notes",
                Some("Work/Notes"),
            )],
        ),
        ("[[Roadmap]]", (11, 11), "x", "[[Roadmap]]x", roadmap()),
        ("[[Roadmap]]", (0, 0), "`", "`[[Roadmap]]", roadmap()),
        ("`[[Roadmap]]", (12, 12), "`", "`[[Roadmap]]`", vec![]),
        ("x [[Roadmap]] y", (1, 4), "z", "xzRoadmap]] y", vec![]),
    ];
    for (source, (start, end), inserted, saved, expected) in cases {
        let mut engine = with_ids(source, LINKED);
        engine
            .replace(
                Revision(0),
                range(start, end),
                inserted,
                InputAction::Isolated,
                &mut ok,
            )
            .unwrap();
        assert_eq!(engine.source_text(), saved, "{source:?}");
        assert_eq!(roles(&engine), expected, "{source:?}");
        as_fresh(&engine, &ids(LINKED), source);
        engine.undo(Revision(1), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source);
    }
}

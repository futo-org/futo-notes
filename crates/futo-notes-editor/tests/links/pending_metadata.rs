use super::*;

#[test]
fn unfinished_urls_elsewhere_do_not_add_metadata_work_to_a_local_keystroke() {
    let mut work = Vec::new();
    for count in [20, 200] {
        let mut session = EditorSession::open(&"x\n\n".repeat(count));
        for index in (0..count).rev() {
            session
                .replace(
                    session.revision(),
                    range(index * 3, index * 3 + 1),
                    "https://x.test",
                    &mut |_| Ok(()),
                )
                .unwrap();
        }
        let change = session
            .replace(session.revision(), range(8, 8), "x", &mut |_| Ok(()))
            .unwrap();
        assert!(session.source_text().starts_with("https://xx.test\n\n"));
        assert!(session
            .project(session.revision(), range(0, 14))
            .unwrap()
            .links
            .is_empty());
        assert!(
            change.work.link_metadata_items > 0,
            "metadata accounting must observe the edited unfinished URL"
        );
        work.push(change.work.link_metadata_items);
    }
    assert_eq!(
        work[0], work[1],
        "distant unfinished URL metadata must stay in its own rows"
    );
}

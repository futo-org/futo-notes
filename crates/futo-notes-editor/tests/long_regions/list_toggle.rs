use super::*;

#[test]
fn removing_one_middle_bullet_reads_only_its_neighboring_rows() {
    use futo_notes_editor::BlockCommand;
    let mut small = None;
    for lines in [1_000, 20_000] {
        let source: String = (0..lines).map(|i| format!("- item {i}\n")).collect();
        let needle = format!("item {}", lines / 2);
        let mut session = EditorSession::open(&source);
        let at = session.display_text().find(&needle).unwrap();
        session.select(session.revision(), caret(at)).unwrap();
        let change = session
            .block_command(
                session.revision(),
                caret(at),
                BlockCommand::BulletList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            session.source_text(),
            source.replacen(&format!("- {needle}\n"), &format!("\n{needle}\n"), 1)
        );
        let measured = total(&change.work);
        if let Some(small) = small {
            assert!(
                measured <= small * 3 / 2 + 1024,
                "middle-item toggle: {small} at1k, {measured} at20k"
            );
        } else {
            assert!(measured < 64 * 1024, "middle-item toggle at1k: {measured}");
            small = Some(measured);
        }
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), source);
        assert_eq!(session.selection(), caret(at));
    }
}

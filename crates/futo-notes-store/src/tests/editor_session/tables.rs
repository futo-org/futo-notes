use super::*;
use futo_notes_editor::{TableCommand, TableKey, TableOutcome};

#[test]
fn table_steps_keep_exact_bytes_through_history_and_checkpoint() {
    {
        let root = TestRoot::new();
        let store = store(&root);
        let original = "| a | b |\r\n| --- | :-: |\r\n| c | d |\r\n";
        store.create("", "grid", original).unwrap();
        let mut session = store.open_editor("grid").unwrap();
        let cell = |session: &StoreEditorSession<'_>, row: usize, column: usize| {
            let table = session
                .inspect_table(session.revision(), range(0, 0))
                .unwrap()
                .unwrap();
            table.rows[row][column].content
        };
        // A typed pipe lands as typed: the body row gains a cell.
        let c = cell(&session, 1, 0).end;
        session.replace(Revision(0), range(c.0, c.0), "|x").unwrap();
        let typed = "| a | b |\r\n| --- | :-: |\r\n| c|x | d |\r\n";
        assert_eq!(session.source_text(), typed);
        let before = session.project(Revision(1), range(0, 10)).unwrap();
        let at = cell(&session, 1, 1);
        assert_eq!(session.source_text(), typed);
        assert_eq!(session.project(Revision(1), range(0, 10)).unwrap(), before);
        session
            .table_command(Revision(1), at, TableCommand::InsertColumnRight)
            .unwrap()
            .unwrap();
        let last = cell(&session, 1, 1);
        session
            .select_with_affinity(Revision(2), last, futo_notes_editor::Affinity::Forward)
            .unwrap();
        let Some(TableOutcome::Edited(_)) =
            session.table_key(Revision(2), TableKey::Enter).unwrap()
        else {
            panic!("last row extends");
        };
        // The new column goes on the widest row only; the shorter header and
        // delimiter row stay padded.
        let expected = "| a | b |\r\n| --- | :-: |\r\n| c|x |  | d |\r\n|  |  |  |  |\r\n";
        assert_eq!(session.source_text(), expected);
        session.undo(Revision(3)).unwrap().unwrap();
        session.redo(Revision(4)).unwrap().unwrap();
        session.checkpoint().unwrap();
        drop(session);
        let mut recovered = store.open_editor("grid").unwrap();
        assert_eq!(recovered.source_text(), expected);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("grid").unwrap(), expected);
    }
}

//! Primitive allocation ledger; scenarios dispatch only public session actions.
use std::cell::RefCell;

#[derive(Clone, Copy, Debug)]
pub(super) enum Buffer {
    Context,
    Render,
    Apply,
}
thread_local! {
    static BUFFERS: RefCell<Vec<(Buffer, usize)>> = const { RefCell::new(Vec::new()) };
}
pub(super) fn allocated(kind: Buffer, bytes: usize) {
    BUFFERS.with(|ledger| ledger.borrow_mut().push((kind, bytes)));
}
fn reset() {
    BUFFERS.with(|ledger| ledger.borrow_mut().clear());
}
fn observed() -> Vec<(Buffer, usize)> {
    BUFFERS.with(|ledger| ledger.borrow().clone())
}
fn range(start: usize, end: usize) -> crate::DisplayRange {
    crate::DisplayRange {
        start: crate::DisplayOffset(start),
        end: crate::DisplayOffset(end),
    }
}

#[test]
fn public_work_covers_every_rendered_buffer_when_a_plain_boundary_repair_succeeds() {
    // This existing worked flanking case has no live Code/URL owner. The
    // independent ledger records real completed allocations at their emitters,
    // including renders subsequently discarded by successful candidate repair.
    let mut session = crate::EditorSession::open("***日😀*** and __b__");
    reset();
    let mut removed = 0;
    let change = session
        .replace(crate::Revision(0), range(7, 8), "", &mut |edit| {
            removed += edit.removed.len();
            Ok(())
        })
        .unwrap();
    assert_eq!(session.source_text(), "***日😀***&#97;nd __b__");
    assert_eq!(session.display_text(), "日😀and b");
    assert_eq!(
        crate::EditorSession::open(&session.source_text()).display_text(),
        "日😀and b"
    );
    assert_budget(&change, removed);
}

fn assert_budget(change: &crate::ViewChange, removed: usize) {
    let buffers = observed();
    assert!(
        buffers
            .iter()
            .filter(|(kind, _)| matches!(kind, Buffer::Render))
            .count()
            > 1,
        "the public action must actually exercise successful repair: {buffers:?}"
    );
    let bytes: usize = buffers.iter().map(|(_, bytes)| bytes).sum();
    assert!(
        change.work.materialized_source_bytes >= bytes + removed,
        "actual source allocations {buffers:?}, accepted removed={removed}, public work={:?}",
        change.work
    );
}

#[test]
fn a_code_literal_repair_keeps_its_existing_render_charge_without_duplication() {
    let mut session = crate::EditorSession::open("");
    session
        .replace(
            crate::Revision(0),
            range(0, 0),
            "<https://x.test/path",
            &mut |_| Ok(()),
        )
        .unwrap();
    session
        .replace(crate::Revision(1), range(20, 20), ">", &mut |_| Ok(()))
        .unwrap();
    session.select(crate::Revision(2), range(15, 20)).unwrap();
    reset();
    let mut removed = 0;
    let change = session
        .toggle_format(crate::Revision(2), crate::InlineFormat::Code, &mut |edit| {
            removed += edit.removed.len();
            Ok(())
        })
        .unwrap()
        .unwrap();
    let buffers = observed();
    assert_eq!(session.display_text(), "<https://x.test/path>");
    let source = session.source_text();
    assert!(source.contains("\\:"));
    let fresh = crate::EditorSession::open(&source);
    assert_eq!(fresh.display_text(), "<https://x.test/path>");
    let query = fresh.project(crate::Revision(0), range(0, 21)).unwrap();
    assert!(query.links.is_empty());
    assert_eq!(
        query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&crate::InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(15, 20)]
    );
    // Snapshot before observational fresh parse (which performs no rendering).
    assert_eq!(buffers.len(), observed().len());
    assert_budget(&change, removed);
}

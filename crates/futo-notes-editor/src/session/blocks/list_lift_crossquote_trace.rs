//! Test-only actual primitive attribution for the single shared-head work probe.
use std::cell::RefCell;

#[derive(Default, Clone, Debug)]
pub(super) struct Ledger {
    pub canonical_metadata: usize,
    pub head_queries: usize,
    pub prefix_copies: usize,
    pub prefix_metadata: usize,
    pub body_calls: usize,
    pub body_bytes: usize,
    pub child_visits: usize,
    pub neighbor_metadata: usize,
    pub emit_metadata: usize,
}
thread_local! {
    static LEDGER: RefCell<Ledger> = RefCell::new(Ledger::default());
}
pub(super) fn metadata() -> usize {
    crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get())
}
pub(super) fn record(update: impl FnOnce(&mut Ledger)) {
    LEDGER.with(|ledger| update(&mut ledger.borrow_mut()));
}
pub(super) fn reset() {
    LEDGER.with(|ledger| *ledger.borrow_mut() = Ledger::default());
}
pub(super) fn get() -> Ledger {
    LEDGER.with(|ledger| ledger.borrow().clone())
}

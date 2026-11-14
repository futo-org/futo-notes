//! The store's side of the durable local rename journal (#214): every journaled
//! move and the crash recovery that finishes or undoes one. The record and the
//! view sync reads live in `futo_notes_core::files::rename_journal`.

mod moves;
mod recovery;
#[cfg(any(test, feature = "test-support"))]
pub mod tests_support;

pub(crate) use futo_notes_core::files::rename_journal::forget_deleted_locked;
pub use futo_notes_core::files::rename_journal::{
    set_rename_scope, with_rename_journal, IntentKey, RenameChain, RenameIntent, RenameJournal,
};
pub(crate) use moves::{commit, move_journaled, JournaledMove};
pub(crate) use recovery::{commit_recovered, parent_missing, recover, recovered_root_stem};

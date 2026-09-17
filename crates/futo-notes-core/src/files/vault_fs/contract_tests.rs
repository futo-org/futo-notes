//! One contract, two implementations.
//!
//! `platform` is the implementation this build ships. `fallback` is the
//! portable one that ships ONLY where `platform` is not it — Windows — and so
//! never ran in a test on any developer machine or CI runner. github#48 is
//! what that cost: its `exists` answered a missing parent folder with an I/O
//! error where the Unix implementation answers `Ok(false)`, so from v1.6.1
//! every note a peer put in a folder the Windows client did not already have
//! failed on every sync cycle, forever, and a fresh Windows install of a
//! foldered vault received none of its foldered notes.
//!
//! Nothing in `fallback` needs Windows to RUN — it is plain `std::fs` — only
//! `cfg(not(unix))` to be COMPILED. So it is compiled here and held to the
//! same rules as the shipped implementation. Add a rule once; both answer it.
//!
//! Rules that depend on descriptor-relative I/O (directory fsync, the
//! interruption/recovery ladder) stay in `tests.rs`, which is Unix-only
//! because those are Unix mechanisms rather than shared contract.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

pub(super) struct TempRoot(PathBuf);

impl TempRoot {
    pub(super) fn new() -> Self {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-vault-fs-contract-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&path).expect("temp root");
        Self(path)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stamps the whole rule set over one implementation.
macro_rules! vault_fs_contract {
    ($suite:ident, $implementation:ident) => {
        mod $suite {
            use super::TempRoot;
            use crate::files::vault_fs::$implementation as vault_fs;

            /// github#48. A note arrives for `Work/Plan.md` and this client has
            /// no `Work` yet: the leaf is ABSENT, not unreadable. Answering with
            /// an error makes the sync engine record a permanent per-note
            /// failure and pin its pull cursor, while the write that follows
            /// would have created the folder on its own.
            #[test]
            fn exists_is_false_when_the_parent_folder_is_missing() {
                let root = TempRoot::new();
                assert_eq!(
                    vault_fs::exists(root.path(), "Work/Plan.md"),
                    Ok(false),
                    "a note whose folder is missing is absent, not an error",
                );
                assert_eq!(
                    vault_fs::exists(root.path(), "Work/Docs/Alpha.md"),
                    Ok(false),
                    "the same holds however many folder levels are missing",
                );
            }

            /// A remote deletion for a note whose folder this client does not
            /// have is already done, not a failure to carry out.
            #[test]
            fn remove_reports_nothing_to_do_when_the_parent_folder_is_missing() {
                let root = TempRoot::new();
                assert_eq!(vault_fs::remove(root.path(), "Work/Plan.md"), Ok(false));
                assert_eq!(
                    vault_fs::remove_local(root.path(), "Work/Docs/Alpha.md"),
                    Ok(false),
                );
            }

            /// Same for a relocation whose source folder is gone: there is
            /// nothing at the source to move.
            #[test]
            fn rename_reports_nothing_moved_when_the_source_parent_folder_is_missing() {
                let root = TempRoot::new();
                assert_eq!(
                    vault_fs::rename(root.path(), "Work/Plan.md", "Plan.md"),
                    Ok(false),
                );
                assert_eq!(
                    vault_fs::rename_local(root.path(), "Work/Plan.md", "Plan.md"),
                    Ok(false),
                );
            }

            #[test]
            fn read_optional_is_none_when_the_parent_folder_is_missing() {
                let root = TempRoot::new();
                assert_eq!(
                    vault_fs::read_optional(root.path(), "Work/Plan.md"),
                    Ok(None)
                );
            }

            /// The other half of the rule, and the reason absence cannot simply
            /// be "any error means no". A PLAIN FILE where a folder belongs is a
            /// real fault the user has to fix, and it must not be reported as an
            /// absent note that a later write would then try to create.
            #[test]
            fn a_file_where_a_parent_folder_belongs_is_an_error_not_absence() {
                let root = TempRoot::new();
                std::fs::write(root.path().join("Work"), "not a folder").unwrap();
                assert!(
                    vault_fs::exists(root.path(), "Work/Plan.md").is_err(),
                    "a file where a folder belongs is a fault, not absence",
                );
                assert!(vault_fs::remove(root.path(), "Work/Plan.md").is_err());
                assert!(vault_fs::rename(root.path(), "Work/Plan.md", "Plan.md").is_err());
            }

            /// Absence on the read side, folders on the write side: the write
            /// path is what creates them, which is why reporting absence is
            /// safe in the first place.
            #[test]
            fn writing_creates_the_missing_parent_folders() {
                let root = TempRoot::new();
                vault_fs::write_atomic(root.path(), "Work/Docs/Alpha.md", b"body").unwrap();
                assert_eq!(
                    vault_fs::exists(root.path(), "Work/Docs/Alpha.md"),
                    Ok(true)
                );
                assert_eq!(
                    vault_fs::read(root.path(), "Work/Docs/Alpha.md"),
                    Ok(b"body".to_vec()),
                );
            }

            /// Absence must not swallow a note that IS there.
            #[test]
            fn a_present_note_is_found_removed_and_then_absent() {
                let root = TempRoot::new();
                vault_fs::write_atomic(root.path(), "Work/Plan.md", b"body").unwrap();
                assert_eq!(vault_fs::exists(root.path(), "Work/Plan.md"), Ok(true));
                assert_eq!(vault_fs::remove(root.path(), "Work/Plan.md"), Ok(true));
                assert_eq!(vault_fs::exists(root.path(), "Work/Plan.md"), Ok(false));
                assert_eq!(vault_fs::remove(root.path(), "Work/Plan.md"), Ok(false));
            }

            /// A note whose folder exists but whose own name does not is the
            /// case that always worked; it is here so a fix for the missing
            /// parent cannot regress it.
            #[test]
            fn exists_is_false_for_a_missing_leaf_inside_a_folder_that_is_there() {
                let root = TempRoot::new();
                std::fs::create_dir(root.path().join("Work")).unwrap();
                assert_eq!(vault_fs::exists(root.path(), "Work/Plan.md"), Ok(false));
            }
        }
    };
}

vault_fs_contract!(shipped_implementation, platform);
vault_fs_contract!(portable_implementation, fallback);

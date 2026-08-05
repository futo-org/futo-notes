use std::path::Path;

use futo_notes_core::files::vault_mutation_guard;

use super::super::vault_fs;
use super::super::PreWrite;
use super::{content_bytes, content_hash};

#[derive(Debug, Eq, PartialEq)]
pub(in crate::sync) enum GuardedWriteOutcome {
    Applied,
    SourceChanged,
    TargetOccupied,
}

pub(in crate::sync) fn replace_content_if_hash_matches(
    root: &Path,
    source: &str,
    target: &str,
    content: &str,
    expected_hash: &str,
    modified_ms: i64,
    pre_write: &PreWrite,
) -> Result<GuardedWriteOutcome, String> {
    let bytes = content_bytes(target, content)?;
    let _vault_mutation = vault_mutation_guard()?;
    if content_hash(root, source).as_deref() != Some(expected_hash) {
        return Ok(GuardedWriteOutcome::SourceChanged);
    }
    if source != target && vault_fs::exists(root, target)? {
        return Ok(GuardedWriteOutcome::TargetOccupied);
    }
    pre_write(target);
    if source != target {
        pre_write(source);
    }
    vault_fs::write_atomic(root, target, &bytes)?;
    if source != target && !vault_fs::remove(root, source)? {
        return Err(format!("replace source disappeared: {source}"));
    }
    if modified_ms > 0 {
        let _ = vault_fs::set_mtime_ms(root, target, modified_ms);
    }
    Ok(GuardedWriteOutcome::Applied)
}

pub(in crate::sync) fn write_content_if_source_and_target_absent(
    root: &Path,
    source: &str,
    target: &str,
    content: &str,
    modified_ms: i64,
    pre_write: &PreWrite,
) -> Result<GuardedWriteOutcome, String> {
    let bytes = content_bytes(target, content)?;
    let _vault_mutation = vault_mutation_guard()?;
    if vault_fs::exists(root, source)? {
        return Ok(GuardedWriteOutcome::SourceChanged);
    }
    if source != target && vault_fs::exists(root, target)? {
        return Ok(GuardedWriteOutcome::TargetOccupied);
    }
    pre_write(target);
    vault_fs::write_atomic(root, target, &bytes)?;
    if modified_ms > 0 {
        let _ = vault_fs::set_mtime_ms(root, target, modified_ms);
    }
    Ok(GuardedWriteOutcome::Applied)
}

pub(in crate::sync) fn copy_content_if_hash_matches(
    root: &Path,
    source: &str,
    target: &str,
    content: &str,
    expected_hash: &str,
    pre_write: &PreWrite,
) -> Result<bool, String> {
    let bytes = content_bytes(target, content)?;
    let _vault_mutation = vault_mutation_guard()?;
    if content_hash(root, source).as_deref() != Some(expected_hash)
        || vault_fs::exists(root, target)?
    {
        return Ok(false);
    }
    pre_write(target);
    vault_fs::write_atomic(root, target, &bytes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use futo_notes_core::hash::hash_sha256;

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-guarded-write-test-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn content_writes_never_follow_symlinked_parents() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "outside").unwrap();
        symlink(outside.path(), root.path().join("linked-directory")).unwrap();

        assert!(write_content_if_source_and_target_absent(
            root.path(),
            "linked-directory/secret.md",
            "linked-directory/secret.md",
            "replacement",
            0,
            &|_| {}
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "outside");
    }

    #[test]
    fn guarded_replacement_does_not_overwrite_an_existing_target() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("source.md"), "expected source").unwrap();
        std::fs::write(root.path().join("target.md"), "independent target").unwrap();

        let replaced = replace_content_if_hash_matches(
            root.path(),
            "source.md",
            "target.md",
            "remote replacement",
            &hash_sha256("expected source"),
            0,
            &|_| {},
        )
        .unwrap();

        assert_eq!(replaced, GuardedWriteOutcome::TargetOccupied);
        assert_eq!(
            std::fs::read_to_string(root.path().join("source.md")).unwrap(),
            "expected source"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("target.md")).unwrap(),
            "independent target"
        );
    }
}

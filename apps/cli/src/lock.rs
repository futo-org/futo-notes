//! The CLI's vault lock: one exclusive OS file lock per canonical vault path,
//! kept in the per-user state directory, never in the vault.
//!
//! It coordinates CLI processes only. The engine's write locks are
//! per-process, which is why the CLI must not share a vault with a running app.
//! The OS drops the lock when the process exits, crash included, so nothing
//! here ever deletes a lock file or takes one over.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::config;
use crate::error::{CliError, CliResult, Code};
use crate::i18n::t;

/// How long a command waits for another CLI process before `vault_busy`.
pub const LOCK_WAIT: Duration = Duration::from_secs(30);

pub struct VaultLock(File);

impl Drop for VaultLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// A short, stable name for a canonical vault path, shared by the lock and the
/// search index so neither leaks the path into a file name.
pub fn vault_digest(root: &Path) -> String {
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    hex::encode(&digest[..8])
}

pub fn lock(root: &Path) -> CliResult<VaultLock> {
    lock_file(&lock_path(root)?, LOCK_WAIT)
}

pub fn lock_path(root: &Path) -> CliResult<PathBuf> {
    Ok(config::state_dir()?
        .join("locks")
        .join(format!("{}.lock", vault_digest(root))))
}

fn lock_file(path: &Path, wait: Duration) -> CliResult<VaultLock> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(CliError::io)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(CliError::io)?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(VaultLock(file)),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(CliError::new(Code::VaultBusy, t("cli.errors.vaultBusy")))
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(CliError::io(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_lock_makes_the_next_one_wait_then_fail_busy() {
        let path = std::env::temp_dir().join(format!("futo-cli-lock-{}", std::process::id()));
        let held = lock_file(&path, Duration::ZERO).unwrap();
        let started = Instant::now();
        let error = lock_file(&path, Duration::from_millis(200))
            .err()
            .expect("second lock must wait and fail");
        assert_eq!(error.code, Code::VaultBusy);
        assert!(started.elapsed() >= Duration::from_millis(200));
        drop(held);
        assert!(lock_file(&path, Duration::ZERO).is_ok());
        let _ = std::fs::remove_file(path);
    }
}

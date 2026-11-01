//! Explicit proportional preparation; first input appends only its small frame
//! before an exclusive no-copy install. Inactive bytes are never recovery input.
use super::*;
use futo_notes_core::files::vault_fs::RecoveryActivation;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) struct PreparedStream {
    path: String,
    header_bytes: u64,
}

impl RecoveryLog {
    pub(in crate::editor_session) fn prepare_bounded(&mut self, root: &Path) -> Result<(), String> {
        if self.failed {
            return Err("editor recovery is paused".into());
        }
        if self.exists {
            return Ok(());
        }
        if self.prepared.is_some() {
            return Ok(());
        }
        let header = self.header_bytes()?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = format!(
            "{}.{}.{}.prepared",
            self.path,
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        self.storage
            .prepare_bounded_stream(root, &path, &self.path, &header)?;
        self.prepared = Some(PreparedStream {
            path,
            header_bytes: header.len() as u64,
        });
        Ok(())
    }

    pub(in crate::editor_session) fn cancel_bounded_preparation(
        &mut self,
        root: &Path,
    ) -> Result<(), String> {
        if self.prepared.is_some() {
            self.storage.discard_bounded_stream(root)?;
            self.prepared = None;
        }
        Ok(())
    }

    pub(super) fn append_prepared(&mut self, root: &Path, record: &[u8]) -> Result<(), String> {
        let prepared = self.prepared.as_ref().unwrap();
        self.storage.verify_bounded_stream(root, &prepared.path)?;
        self.storage.append(root, &prepared.path, record)?;
        match self.storage.activate_bounded_stream(root)? {
            RecoveryActivation::Occupied => Err("editor recovery stream already exists".into()),
            RecoveryActivation::Installed { durability } => {
                self.exists = true;
                durability?;
                self.accepted_bytes = prepared.header_bytes + record.len() as u64;
                Ok(())
            }
        }
    }

    pub(super) fn repair_prepared(&mut self, root: &Path) -> Result<(), String> {
        let prepared = self.prepared.as_ref().unwrap();
        // Remove canonical authority before truncating a rejected first frame.
        // A crash must never expose a clean header-only live stream. Checking
        // absence also keeps a foreign collision paused instead of allowing an
        // endless series of resumed inputs to hit that same foreign stream.
        self.storage.deactivate_bounded_stream(root)?;
        self.exists = false;
        self.storage.verify_bounded_stream(root, &prepared.path)?;
        self.storage
            .truncate(root, &prepared.path, prepared.header_bytes)?;
        self.storage.flush(root, &prepared.path)
    }
}

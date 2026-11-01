//! Bounded-only v4 reservation. Entry exclusively creates the canonical stream
//! and durably writes its exact header through a pinned inode; first input
//! appends only its small frame there. No hard link, rename or base copy.
use super::*;

impl RecoveryLog {
    pub(in crate::editor_session) fn prepare_bounded(&mut self, root: &Path) -> Result<(), String> {
        if self.failed {
            return Err("editor recovery is paused".into());
        }
        if self.exists {
            return Ok(());
        }
        // The original baseline, revision and outside-writer epoch are kept.
        let mut header = self.header.clone();
        header.version = format::BOUNDED_VERSION;
        let bytes = format::encode(&header)?;
        if let Err(error) = self.storage.reserve(root, &self.path, &bytes) {
            if let Err(cleanup) = self.storage.remove_reservation(root) {
                self.failed = true;
                return Err(format!("{error}; {cleanup}"));
            }
            return Err(error);
        }
        self.header = header;
        self.exists = true;
        self.accepted_bytes = bytes.len() as u64;
        self.reservation = Some(self.accepted_bytes);
        Ok(())
    }

    /// Clean cancellation removes only the pinned reservation while it holds
    /// no accepted record. Active recovery is retained.
    pub(in crate::editor_session) fn cancel_reservation(
        &mut self,
        root: &Path,
    ) -> Result<(), String> {
        if self.failed || self.reservation != Some(self.accepted_bytes) {
            return Ok(());
        }
        self.storage.remove_reservation(root)?;
        self.exists = false;
        self.accepted_bytes = 0;
        self.reservation = None;
        self.header.version = format::VERSION;
        Ok(())
    }

    /// A strictly clean reservation found by an editable reopen is pinned,
    /// re-checked and durably retired before any append. Failure pauses
    /// acceptance while current markdown stays copyable.
    pub(super) fn retire_stale_reservation(&mut self, root: &Path) -> Result<(), String> {
        let Some(expected) = self.stale.clone() else {
            return Ok(());
        };
        let result = (|| {
            // Retry a previously verified pin whose removal failed.
            self.storage.remove_reservation(root)?;
            if self.storage.pin(root, &self.path)?.as_ref() == Some(&expected) {
                return self.storage.remove_reservation(root);
            }
            self.storage.release_pin();
            match self.storage.read(root, &self.path)? {
                None => Ok(()),
                Some(_) => Err("editor recovery reservation changed; retained".into()),
            }
        })();
        if let Err(error) = result {
            self.failed = true;
            return Err(error);
        }
        self.stale = None;
        self.exists = false;
        Ok(())
    }
}

impl Drop for RecoveryLog {
    fn drop(&mut self) {
        if self.reservation.is_some() {
            let root = self.root.clone();
            if let Err(error) = self.cancel_reservation(&root) {
                futo_notes_core::log_to_stderr!("editor recovery reservation cleanup: {error}");
            }
        }
    }
}

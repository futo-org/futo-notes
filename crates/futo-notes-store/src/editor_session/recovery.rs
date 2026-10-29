use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::{RecoveryClock, RecoveryStorage};

use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::{EditorSession, Revision, SourceEdit};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    vault: String,
    id: String,
    base: String,
    base_revision: Revision,
}

pub(super) struct RecoveryLog {
    path: String,
    header: Header,
    storage: Box<dyn RecoveryStorage>,
    exists: bool,
    accepted_bytes: u64,
    pub(super) failed: bool,
    pub(super) accepted: Revision,
    pub(super) durable: Revision,
    pub(super) flush_deadline: Option<Duration>,
    pub(super) last_flush_lateness: Option<Duration>,
    clock: Arc<dyn RecoveryClock>,
    #[cfg(test)]
    pub(super) append_hook: Option<Box<dyn Fn(bool)>>,
    #[cfg(test)]
    pub(super) fail_retirement: bool,
}

impl RecoveryLog {
    pub(super) fn open(
        root: &Path,
        id: &str,
        disk: &str,
        clock: Arc<dyn RecoveryClock>,
        mut storage: Box<dyn RecoveryStorage>,
    ) -> Result<(Self, EditorSession), String> {
        let path = format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id));
        let vault = root
            .canonicalize()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let bytes = storage.read(root, &path)?;
        let accepted_bytes = bytes.as_ref().map_or(0, |bytes| bytes.len() as u64);
        let exists = bytes.is_some();
        let (header, engine) = match bytes {
            None => (
                Header {
                    version: 1,
                    vault,
                    id: id.to_owned(),
                    base: disk.to_owned(),
                    base_revision: Revision(0),
                },
                EditorSession::open(disk),
            ),
            Some(bytes) => {
                if !bytes.ends_with(b"\n") {
                    return Err("incomplete editor recovery record; log retained".to_owned());
                }
                let mut lines = bytes.split(|byte| *byte == b'\n');
                let header: Header = serde_json::from_slice(lines.next().unwrap_or_default())
                    .map_err(|error| error.to_string())?;
                if header.version != 1 || header.vault != vault || header.id != id {
                    return Err(
                        "editor recovery identity or version mismatch; log retained".to_owned()
                    );
                }
                let mut engine = EditorSession::restore(&header.base, header.base_revision);
                for line in lines.filter(|line| !line.is_empty()) {
                    let edit: SourceEdit =
                        serde_json::from_slice(line).map_err(|error| error.to_string())?;
                    engine.replay(&edit).map_err(|error| error.to_string())?;
                }
                (header, engine)
            }
        };
        let revision = engine.revision();
        let durable = header.base_revision;
        Ok((
            Self {
                path,
                header,
                storage,
                exists,
                accepted_bytes,
                failed: false,
                accepted: revision,
                durable,
                flush_deadline: if revision != durable {
                    Some(clock.now() + Duration::from_millis(100))
                } else {
                    None
                },
                last_flush_lateness: None,
                clock,
                #[cfg(test)]
                append_hook: None,
                #[cfg(test)]
                fail_retirement: false,
            },
            engine,
        ))
    }

    pub(super) fn base(&self) -> &str {
        &self.header.base
    }

    pub(super) fn append(&mut self, root: &Path, edit: &SourceEdit) -> Result<(), String> {
        if self.failed {
            return Err(
                "editor recovery append failed; reopen or retry recovery before editing".to_owned(),
            );
        }
        #[cfg(test)]
        if let Some(hook) = &self.append_hook {
            hook(false);
        }
        let result = self.append_record(root, edit);
        if result.is_err() {
            self.failed = true;
        }
        #[cfg(test)]
        if result.is_ok() {
            if let Some(hook) = &self.append_hook {
                hook(true);
            }
        }
        if result.is_ok() {
            self.accepted = edit.revision;
            self.flush_deadline
                .get_or_insert_with(|| self.clock.now() + Duration::from_millis(100));
        }
        result
    }

    fn header_bytes(&self) -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(&self.header).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn append_record(&mut self, root: &Path, edit: &SourceEdit) -> Result<(), String> {
        if !self.exists {
            let header = self.header_bytes()?;
            self.storage.create(root, &self.path, &header)?;
            self.accepted_bytes = header.len() as u64;
            self.exists = true;
        }
        let mut record = serde_json::to_vec(edit).map_err(|error| error.to_string())?;
        record.push(b'\n');
        self.storage.append(root, &self.path, &record)?;
        self.accepted_bytes += record.len() as u64;
        Ok(())
    }

    pub(super) fn resume(&mut self, root: &Path) -> Result<(), String> {
        // Only the tail of a failed append in this live session is discarded.
        // Never salvage or rewrite an arbitrary log discovered on open here.
        if self.accepted_bytes == 0 {
            self.storage.remove(root, &self.path)?;
            let header = self.header_bytes()?;
            self.storage.create(root, &self.path, &header)?;
            self.accepted_bytes = header.len() as u64;
            self.exists = true;
        } else {
            self.storage
                .truncate(root, &self.path, self.accepted_bytes)?;
        }
        self.storage.flush(root, &self.path)?;
        self.durable = self.accepted;
        self.last_flush_lateness = self
            .flush_deadline
            .map(|deadline| self.clock.now().saturating_sub(deadline));
        self.flush_deadline = None;
        self.failed = false;
        Ok(())
    }

    pub(super) fn flush_delay(&self) -> Option<Duration> {
        self.flush_deadline
            .map(|deadline| deadline.saturating_sub(self.clock.now()))
    }

    pub(super) fn flush_due(&self) -> bool {
        self.flush_delay().is_some_and(|delay| delay.is_zero())
    }

    pub(super) fn flush(&mut self, root: &Path) -> Result<(), String> {
        if self.accepted != self.durable {
            if let Err(error) = self.storage.flush(root, &self.path) {
                self.failed = true;
                return Err(error);
            }
            self.durable = self.accepted;
            self.last_flush_lateness = self
                .flush_deadline
                .map(|deadline| self.clock.now().saturating_sub(deadline));
            self.flush_deadline = None;
        }
        Ok(())
    }

    pub(super) fn retire(
        &mut self,
        root: &Path,
        id: &str,
        source: &str,
        revision: Revision,
    ) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_retirement {
            return Err("injected recovery retirement failure".to_owned());
        }
        // Close the append handle before unlink, including on Windows. A failed
        // retirement leaves the old base usable for repeat recovery.
        self.storage.remove(root, &self.path)?;
        self.exists = false;
        self.accepted_bytes = 0;
        self.path = format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id));
        self.header.id = id.to_owned();
        self.header.base = source.to_owned();
        self.header.base_revision = revision;
        self.failed = false;
        self.durable = revision;
        self.flush_deadline = None;
        Ok(())
    }
}

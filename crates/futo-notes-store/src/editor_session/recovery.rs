use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::recovery_format::{self as format, Header, Record};
use super::{RecoveryClock, RecoveryIssue, RecoveryIssueKind, RecoveryStorage};

use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::{EditorSession, Revision, SourceEdit};
pub(super) struct RecoveryLog {
    path: String,
    pub(super) checkpoint_target: Option<String>,
    header: Header,
    storage: Box<dyn RecoveryStorage>,
    exists: bool,
    accepted_bytes: u64,
    pub(super) failed: bool,
    pub(super) issue: Option<RecoveryIssue>,
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
        let exists = bytes.is_some();
        let mut accepted_bytes = 0;
        let mut issue = None;
        let mut checkpoint_target = None;
        let mut header = Header {
            version: format::VERSION,
            vault: vault.clone(),
            id: id.to_owned(),
            base: disk.to_owned(),
            base_revision: Revision(0),
        };
        let mut engine = EditorSession::open(disk);
        if let Some(bytes) = bytes {
            let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
            let first = lines.next().unwrap_or_default();
            match format::decode_header(first) {
                Ok(found) if found.version != format::VERSION => {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::UnsupportedVersion {
                            version: found.version,
                        },
                        record: 0,
                    })
                }
                Ok(found) if found.vault != vault || found.id != id => {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::IdentityMismatch,
                        record: 0,
                    })
                }
                Ok(found) if first.ends_with(b"\n") => {
                    header = found;
                    accepted_bytes = first.len() as u64;
                    engine = EditorSession::restore(&header.base, header.base_revision);
                    let (validated, target, problem) = replay_records(root, &mut engine, lines);
                    accepted_bytes += validated;
                    checkpoint_target = target;
                    issue = problem;
                    if issue.is_none() && disk != header.base && disk != engine.source_text() {
                        issue = Some(RecoveryIssue {
                            kind: RecoveryIssueKind::BaseMismatch,
                            record: 0,
                        });
                    }
                }
                Ok(_) => {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::CorruptRecord,
                        record: 0,
                    })
                }
                Err(error) => issue = Some(error),
            }
        }
        let failed = issue
            .as_ref()
            .is_some_and(|issue| issue.kind != RecoveryIssueKind::BaseMismatch);
        let revision = engine.revision();
        let durable = header.base_revision;
        Ok((
            Self {
                path,
                checkpoint_target,
                header,
                storage,
                exists,
                accepted_bytes,
                failed,
                issue,
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
            self.checkpoint_target = None;
            self.flush_deadline
                .get_or_insert_with(|| self.clock.now() + Duration::from_millis(100));
        }
        result
    }

    fn header_bytes(&self) -> Result<Vec<u8>, String> {
        format::encode(&self.header)
    }

    fn append_record(&mut self, root: &Path, edit: &SourceEdit) -> Result<(), String> {
        if !self.exists {
            let header = self.header_bytes()?;
            self.storage.create(root, &self.path, &header)?;
            self.accepted_bytes = header.len() as u64;
            self.exists = true;
        }
        let record = format::encode(&Record::Edit(edit.clone()))?;
        self.storage.append(root, &self.path, &record)?;
        self.accepted_bytes += record.len() as u64;
        Ok(())
    }

    pub(super) fn protect_checkpoint(&mut self, root: &Path, id: &str) -> Result<(), String> {
        let record = format::encode(&Record::Checkpoint {
            id: id.to_owned(),
            revision: self.accepted,
        })?;
        if let Err(error) = self.storage.append(root, &self.path, &record) {
            self.failed = true;
            return Err(error);
        }
        self.accepted_bytes += record.len() as u64;
        self.checkpoint_target = Some(id.to_owned());
        // A target must survive power loss before markdown installation can
        // make its outcome ambiguous. A scheduled flush is insufficient here.
        if let Err(error) = self.storage.flush(root, &self.path) {
            self.failed = true;
            return Err(error);
        }
        self.durable = self.accepted;
        self.last_flush_lateness = self
            .flush_deadline
            .map(|deadline| self.clock.now().saturating_sub(deadline));
        self.flush_deadline = None;
        Ok(())
    }

    pub(super) fn resume(&mut self, root: &Path) -> Result<(), String> {
        // The caller admits only failed live appends/flushes or a validated
        // prefix with an incomplete final frame. Interior damage never reaches
        // this truncation path.
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
        self.issue = None;
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
        self.checkpoint_target = None;
        self.accepted_bytes = 0;
        self.path = format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id));
        self.header.id = id.to_owned();
        self.header.base = source.to_owned();
        self.header.base_revision = revision;
        self.failed = false;
        self.issue = None;
        self.durable = revision;
        self.flush_deadline = None;
        Ok(())
    }
}

/// Stop at the first incomplete or invalid frame. In particular, never skip an
/// invalid edit and try to apply a later one against a guessed source state.
fn replay_records<'a>(
    root: &Path,
    engine: &mut EditorSession,
    lines: impl Iterator<Item = &'a [u8]>,
) -> (u64, Option<String>, Option<RecoveryIssue>) {
    let mut accepted_bytes = 0;
    let mut checkpoint_target = None;
    let mut issue = None;
    for (index, line) in lines.enumerate() {
        let record = index + 1;
        if !line.ends_with(b"\n") {
            issue = Some(RecoveryIssue {
                kind: RecoveryIssueKind::TornTail,
                record,
            });
            break;
        }
        match format::decode::<Record>(line, record) {
            Ok(Record::Edit(edit)) => {
                if edit.previous_revision != engine.revision() {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::SequenceMismatch,
                        record,
                    });
                    break;
                }
                if engine.replay(&edit).is_err() {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::InvalidEdit,
                        record,
                    });
                    break;
                }
                checkpoint_target = None;
                accepted_bytes += line.len() as u64;
            }
            Ok(Record::Checkpoint { id, revision }) => {
                if revision != engine.revision() || crate::paths::note_path(root, &id).is_err() {
                    issue = Some(RecoveryIssue {
                        kind: RecoveryIssueKind::InvalidEdit,
                        record,
                    });
                    break;
                }
                checkpoint_target = Some(id);
                accepted_bytes += line.len() as u64;
            }
            Err(error) => {
                issue = Some(error);
                break;
            }
        }
    }
    (accepted_bytes, checkpoint_target, issue)
}

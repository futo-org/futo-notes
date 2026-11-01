//! Discoverable prepared intent and durable decision retain the original stream
//! until a coherent final identity, baseline and accepted source are installed.
use super::*;
use futo_notes_editor::OwnActionRelink;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Intent {
    header: Header,
    records: Vec<u8>,
    exists: bool,
    destination: String,
    expected_disk: Vec<String>,
    replaced: bool,
    action: OwnActionRelink,
    can_adopt: bool,
}
#[derive(Serialize, Deserialize)]
struct Decision {
    intent: Intent,
    header: Header,
    stream: Vec<u8>,
}
fn stem(id: &str) -> String {
    format!(".futo-editor-recovery/{}.retarget", hash_sha256(id))
}
fn stream(id: &str) -> String {
    format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    format::decode(bytes, 0).map_err(|error| format!("invalid editor identity intent: {error:?}"))
}
impl RecoveryLog {
    pub(in crate::editor_session) fn cancel_prepared_identity(
        &mut self,
        root: &Path,
    ) -> Result<(), String> {
        let path = stem(&self.header.id);
        if self
            .storage
            .read(root, &format!("{path}.committed"))?
            .is_some()
        {
            return Err("committed identity cannot be canceled".into());
        }
        if let Some(bytes) = self.storage.read(root, &path)? {
            let intent: Intent = decode(&bytes)?;
            validate(root, &intent)?;
            let current = futo_notes_core::files::vault_fs::read_optional(
                root,
                &crate::note_filename(&intent.header.id),
            )?;
            if current.as_deref() != intent.expected_disk.first().map(|value| value.as_bytes())
                || (intent.header.id != intent.destination
                    && futo_notes_core::files::collision_key(&intent.header.id)
                        == futo_notes_core::files::collision_key(&intent.destination)
                    && !crate::vault::note_paths(root)
                        .iter()
                        .any(|(id, _)| id == &intent.header.id))
            {
                return Err("identity source changed; prepared intent retained".into());
            }
        }
        self.storage.remove(root, &path)
    }
    /// Snapshot only artifacts owned by transitions touching this identity.
    /// A foreign destination stream is never part of the retiring incarnation.
    pub(in crate::editor_session) fn identity_artifacts(
        root: &Path,
        id: &str,
        storage: &mut dyn RecoveryStorage,
    ) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut artifacts = Vec::new();
        for path in storage.list(root)? {
            if path.ends_with(".jsonl") {
                if let Some(bytes) = storage.read(root, &path)? {
                    let first = bytes
                        .split_inclusive(|byte| *byte == b'\n')
                        .next()
                        .unwrap_or_default();
                    if let Ok(header) = format::decode_header(first) {
                        if futo_notes_core::files::collision_key(&header.id)
                            == futo_notes_core::files::collision_key(id)
                            && path == stream(&header.id)
                            && header.vault
                                == root
                                    .canonicalize()
                                    .map_err(|error| error.to_string())?
                                    .to_string_lossy()
                        {
                            artifacts.push((path, bytes));
                        }
                    }
                }
                continue;
            }
            if !path.ends_with(".retarget") && !path.ends_with(".retarget.committed") {
                continue;
            }
            let Some(bytes) = storage.read(root, &path)? else {
                continue;
            };
            let (intent, installed) = if path.ends_with(".committed") {
                let decision: Decision = decode(&bytes)?;
                let installed = (stream(&decision.header.id), decision.stream);
                (decision.intent, Some(installed))
            } else {
                (decode::<Intent>(&bytes)?, None)
            };
            if futo_notes_core::files::collision_key(&intent.header.id)
                != futo_notes_core::files::collision_key(id)
                && futo_notes_core::files::collision_key(&intent.destination)
                    != futo_notes_core::files::collision_key(id)
            {
                continue;
            }
            validate(root, &intent)?;
            let source = stream(&intent.header.id);
            if let Some(source_bytes) = storage.read(root, &source)? {
                // Before installation the source stream belongs to the
                // transition, even when destination installation failed.
                artifacts.push((source, source_bytes));
            }
            if let Some((target, expected)) = installed {
                if storage.read(root, &target)?.as_ref() == Some(&expected) {
                    artifacts.push((target, expected));
                }
            }
            artifacts.push((path, bytes));
        }
        artifacts.sort();
        artifacts.dedup();
        Ok(artifacts)
    }
    pub(in crate::editor_session) fn prepare_identity(
        &mut self,
        root: &Path,
        destination: &str,
        expected_disk: Vec<String>,
        action: &OwnActionRelink,
        can_adopt: bool,
    ) -> Result<(), String> {
        self.cancel_reservation(root)?;
        Self::recover_identities(root, &self.header.id, &mut *self.storage)?;
        let records = if self.exists {
            let bytes = self
                .storage
                .read(root, &self.path)?
                .ok_or("editor stream disappeared")?;
            let first = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or("incomplete recovery header")?
                + 1;
            bytes
                .get(first..self.accepted_bytes as usize)
                .ok_or("incomplete accepted recovery prefix")?
                .to_vec()
        } else {
            Vec::new()
        };
        let intent = Intent {
            header: self.header.clone(),
            records,
            exists: self.exists,
            destination: destination.to_owned(),
            expected_disk,
            replaced: self.replaced(root)?,
            action: action.clone(),
            can_adopt,
        };
        let path = stem(&self.header.id);
        self.storage
            .create(root, &path, &format::encode(&intent)?)?;
        self.storage.flush(root, &path)
    }
    pub(in crate::editor_session) fn identity_destination_ready(
        &mut self,
        root: &Path,
        original: &str,
    ) -> Result<bool, String> {
        if let Some(bytes) = self
            .storage
            .read(root, &format!("{}.committed", stem(original)))?
        {
            let decision: Decision = decode(&bytes)?;
            let found = self.storage.read(root, &stream(&decision.header.id))?;
            Ok(found.is_none_or(|found| found == decision.stream))
        } else {
            let bytes = self
                .storage
                .read(root, &stem(original))?
                .ok_or("identity intent disappeared")?;
            let intent: Intent = decode(&bytes)?;
            Ok(self
                .storage
                .read(root, &stream(&intent.destination))?
                .is_none())
        }
    }
    pub(in crate::editor_session) fn install_identity(
        &mut self,
        root: &Path,
        original: &str,
    ) -> Result<(), String> {
        self.cancel_reservation(root)?;
        let decision = install(root, &stem(original), &mut *self.storage)?;
        // Installation replaced or retired any pinned original inode.
        self.reservation = None;
        self.path = stream(&decision.header.id);
        self.header = decision.header;
        self.exists = decision.intent.exists || self.header.source.is_some();
        self.accepted_bytes = if self.exists {
            decision.stream.len() as u64
        } else {
            0
        };
        self.accepted = self.header.base_revision;
        self.durable = self.accepted;
        self.flush_deadline = None;
        self.failed = false;
        self.issue = None;
        Ok(())
    }
    pub(in crate::editor_session) fn cleanup_identity(
        &mut self,
        root: &Path,
        original: &str,
    ) -> Result<(), String> {
        cleanup(root, &stem(original), &mut *self.storage)
    }
    pub(in crate::editor_session) fn snapshot_source(&self) -> &str {
        self.header.source.as_deref().unwrap_or(&self.header.base)
    }
    pub(in crate::editor_session) fn recover_identities(
        root: &Path,
        id: &str,
        storage: &mut dyn RecoveryStorage,
    ) -> Result<(), String> {
        let mut paths = storage
            .list(root)?
            .into_iter()
            .filter_map(|path| {
                if path.ends_with(".retarget") {
                    Some(path)
                } else {
                    path.strip_suffix(".retarget.committed")
                        .map(|prefix| format!("{prefix}.retarget"))
                }
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        for path in paths {
            if let Some(bytes) = storage.read(root, &format!("{path}.committed"))? {
                let decision: Decision = decode(&bytes)?;
                if decision.header.id != id && decision.intent.header.id != id {
                    continue;
                }
                validate(root, &decision.intent)?;
                if decision.header.id == id
                    && decision.intent.header.id != id
                    && storage
                        .read(root, &stream(id))?
                        .is_some_and(|found| found != decision.stream)
                {
                    continue;
                }
                install(root, &path, storage)?;
                cleanup(root, &path, storage)?;
            } else if let Some(bytes) = storage.read(root, &path)? {
                let intent: Intent = decode(&bytes)?;
                if intent.header.id != id && intent.destination != id {
                    continue;
                }
                validate(root, &intent)?;
                if intent.destination == id
                    && intent.header.id != id
                    && storage.read(root, &stream(id))?.is_some()
                {
                    continue;
                }
                let old = crate::note_filename(&intent.header.id);
                let destination = crate::note_filename(&intent.destination);
                let exact_source = futo_notes_core::files::collision_key(&intent.header.id)
                    != futo_notes_core::files::collision_key(&intent.destination)
                    || crate::vault::note_paths(root)
                        .iter()
                        .any(|(found, _)| found == &intent.header.id);
                let current = futo_notes_core::files::vault_fs::read(root, &destination).ok();
                if intent.header.id != intent.destination && exact_source {
                    if let Some(old_disk) =
                        futo_notes_core::files::vault_fs::read_optional(root, &old)?
                    {
                        if intent
                            .expected_disk
                            .first()
                            .is_some_and(|expected| expected.as_bytes() == old_disk)
                        {
                            storage.remove(root, &path)?;
                            continue;
                        }
                        return Err("prepared identity source changed; intent retained".into());
                    }
                }
                if !current.as_ref().is_some_and(|current| {
                    intent
                        .expected_disk
                        .iter()
                        .any(|expected| expected.as_bytes() == current)
                }) {
                    return Err("identity outcome is ambiguous; original draft retained".into());
                }
                install(root, &path, storage)?;
                cleanup(root, &path, storage)?;
            }
        }
        Ok(())
    }
}
fn validate(root: &Path, intent: &Intent) -> Result<(), String> {
    crate::paths::note_path(root, &intent.header.id)?;
    crate::paths::note_path(root, &intent.destination)?;
    if intent.header.vault
        != root
            .canonicalize()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
    {
        return Err("identity intent belongs to another vault".into());
    }
    Ok(())
}
fn decide(root: &Path, intent: Intent) -> Result<Decision, String> {
    validate(root, &intent)?;
    let mut engine = EditorSession::restore(
        intent
            .header
            .source
            .as_deref()
            .unwrap_or(&intent.header.base),
        intent.header.base_revision,
    );
    let (_, _, issue) = replay_records(
        root,
        &mut engine,
        intent.records.split_inclusive(|byte| *byte == b'\n'),
    );
    if issue.is_some() {
        return Err("identity intent contains an invalid accepted prefix".into());
    }
    let disk = crate::note_filename(&intent.destination);
    let actual = String::from_utf8(futo_notes_core::files::vault_fs::read(root, &disk)?)
        .map_err(|error| error.to_string())?;
    if !intent.expected_disk.contains(&actual) {
        return Err("identity destination changed before decision; draft retained".into());
    }
    let before = intent
        .expected_disk
        .first()
        .ok_or("identity intent has no source observation")?;
    let mut header = intent.header.clone();
    header.version = format::VERSION;
    header.id = intent.destination.clone();
    if actual != *before {
        if engine.source_text() == *before && intent.can_adopt {
            engine
                .apply_own_relink(engine.revision(), &intent.action, &mut |_| Ok(()))
                .map_err(|error| error.to_string())?;
            if engine.source_text() != actual {
                return Err(
                    "committed backlink bytes differ from coordinated source change".into(),
                );
            }
            header.base = actual;
        } else if header.base == *before {
            // New accepted typing (or provisional input) refused adoption.
            // Its exact source/history stay intact against the own-action base.
            header.base = actual;
        }
    }
    let epoch = futo_notes_core::files::recovery_coordination::replacement_epoch(root, &header.id)?;
    header.replacement_epoch = if intent.replaced {
        if epoch == 0 {
            return Err("replacement observation cannot be transferred".into());
        }
        0
    } else {
        epoch
    };
    let source = engine.source_text();
    header.source = (source != header.base).then_some(source);
    header.base_revision = engine.revision();
    let bytes = format::encode(&header)?;
    Ok(Decision {
        intent,
        header,
        stream: bytes,
    })
}
fn install(root: &Path, path: &str, storage: &mut dyn RecoveryStorage) -> Result<Decision, String> {
    let decision_path = format!("{path}.committed");
    let decision = if let Some(bytes) = storage.read(root, &decision_path)? {
        decode::<Decision>(&bytes)?
    } else {
        let bytes = storage
            .read(root, path)?
            .ok_or("identity intent disappeared")?;
        let decision = decide(root, decode(&bytes)?)?;
        storage.create(root, &decision_path, &format::encode(&decision)?)?;
        storage.flush(root, &decision_path)?;
        decision
    };
    validate(root, &decision.intent)?;
    let destination = stream(&decision.header.id);
    let needs_stream = decision.intent.exists || decision.header.source.is_some();
    if needs_stream {
        let found = storage.read(root, &destination)?;
        if found.as_ref() != Some(&decision.stream) {
            if decision.intent.header.id == decision.header.id {
                // This attachment owns the original stream. Replacement is
                // atomic and the durable decision retains its complete source.
                storage.replace(root, &destination, &decision.stream)?;
            } else if found.is_none() {
                storage.create(root, &destination, &decision.stream)?;
            } else {
                return Err(
                    "identity destination has another recovery stream; both retained".into(),
                );
            }
        }
        storage.flush(root, &destination)?;
        if decision.intent.header.id != decision.header.id {
            storage.remove(root, &stream(&decision.intent.header.id))?;
        }
    }
    Ok(decision)
}
fn cleanup(root: &Path, path: &str, storage: &mut dyn RecoveryStorage) -> Result<(), String> {
    storage.remove(root, path)?;
    storage.remove(root, &format!("{path}.committed"))
}
